const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/database');
const logger = require('../../utils/logger');
const { createAuthHeader } = require('../../utils/crypto');

const DELIVERY_CHARGE = 30;

// Build ONDC quote from selected items
// Returns { quote, outOfStockItems } — outOfStockItems is an array of item IDs with insufficient stock
const buildQuote = async (items, tenantId) => {
  const productIds = items.map(item => item.id);

  const [products] = await pool.query(
    `SELECT external_product_id, name, price, stock FROM products
     WHERE tenant_id = ? AND external_product_id IN (?)`,
    [tenantId, productIds]
  );

  const productMap = {};
  for (const p of products) productMap[p.external_product_id] = p;

  let itemTotal = 0;
  const breakup = [];
  const outOfStockItems = [];

  for (const item of items) {
    const product = productMap[item.id];
    const qty = item.quantity?.count || 1;
    if (!product || product.stock < qty) {
      outOfStockItems.push(item.id);
      continue;
    }
    const price = parseFloat(product.price);
    const lineTotal = price * qty;
    itemTotal += lineTotal;
    breakup.push({
      title: product.name,
      '@ondc/org/item_id': String(item.id),
      '@ondc/org/item_quantity': { count: qty },
      '@ondc/org/title_type': 'item',
      price: { currency: 'INR', value: lineTotal.toFixed(2) },
      item: {
        quantity: {
          available: { count: String(product.stock || qty) },
          maximum:   { count: String(product.stock || qty) },
        },
        price: { currency: 'INR', value: price.toFixed(2) },
      },
    });
  }

  breakup.push({
    title: 'Delivery charges',
    '@ondc/org/item_id': 'f1',
    '@ondc/org/title_type': 'delivery',
    price: { currency: 'INR', value: String(DELIVERY_CHARGE) },
  });

  const total = (itemTotal + DELIVERY_CHARGE).toFixed(2);
  return {
    quote: { price: { currency: 'INR', value: total }, breakup, ttl: 'P1D' },
    outOfStockItems,
  };
};

// Build a full ONDC order object
const buildOrderObject = (context, message, state, quote, ondcConfig) => {
  const order = message?.order || {};
  return {
    id: order.id || uuidv4(),
    state,
    provider: order.provider,
    items: order.items,
    billing: order.billing,
    fulfillments: (order.fulfillments || []).map(f => ({
      ...f,
      state: { descriptor: { code: state } },
    })),
    quote: quote || order.quote,
    payment: order.payment,
    created_at: order.created_at || new Date().toISOString(),
    updated_at: order.updated_at || new Date().toISOString(),
  };
};

// Get tenant + ONDC config matching a given bpp_id (or first active tenant)
const getTenantByBppId = async (bppId) => {
  const baseQuery = `
    SELECT t.*, oc.id as ondc_config_id,
           oc.subscriber_id, oc.subscriber_url,
           oc.signing_private_key, oc.unique_key_id, oc.ondc_env
    FROM tenants t
    JOIN tenant_ondc_config oc ON oc.tenant_id = t.id
    WHERE t.status = 'active' AND oc.is_active = 1
  `;

  if (bppId) {
    const [rows] = await pool.query(`${baseQuery} AND oc.subscriber_id = ? LIMIT 1`, [bppId]);
    if (rows.length) return { ...rows[0], tenant_id: rows[0].id };
  }

  const [fallback] = await pool.query(`${baseQuery} LIMIT 1`);
  return fallback.length ? { ...fallback[0], tenant_id: fallback[0].id } : null;
};

// Send async callback to BAP with retry (3 attempts, exponential backoff)
const sendCallback = async (bapUri, action, context, message, ondcConfig, retries = 3) => {
  if (!bapUri) { logger.warn(`sendCallback: no bap_uri for ${action}`); return; }

  const callbackUrl = `${bapUri}/${action}`;
  const payload = {
    context: {
      ...context,
      action,
      bpp_id:     ondcConfig?.subscriber_id,
      bpp_uri:    ondcConfig?.subscriber_url,
      timestamp:  new Date().toISOString(),
      message_id: uuidv4(),
      ttl:        'PT30S',
    },
    message,
  };

  // Log outbound transaction
  try {
    await pool.query(
      `INSERT INTO ondc_transactions
         (tenant_id, action, direction, transaction_id, message_id, bap_id, payload, status)
       VALUES (?, ?, 'out', ?, ?, ?, ?, 'pending')`,
      [
        ondcConfig?.tenant_id || ondcConfig?.id,
        action,
        context?.transaction_id,
        payload.context.message_id,
        context?.bap_id,
        JSON.stringify(payload),
      ]
    );
  } catch (e) {
    logger.warn('Transaction log insert failed:', e.message);
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      try {
        if (ondcConfig?.signing_private_key) {
          headers['Authorization'] = createAuthHeader(
            ondcConfig.signing_private_key,
            ondcConfig.subscriber_id,
            ondcConfig.unique_key_id,
            payload
          );
        }
      } catch (e) {
        logger.warn('Auth header skipped:', e.message);
      }

      const response = await axios.post(callbackUrl, payload, { headers, timeout: 30000 });
      logger.info(`${action} → ${callbackUrl} [${response.status}]`);

      pool.query(
        `UPDATE ondc_transactions SET status = 'success', response = ?
         WHERE transaction_id = ? AND action = ? AND direction = 'out'`,
        [JSON.stringify(response.data), context?.transaction_id, action]
      ).catch(() => {});

      return response.data;
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
      logger.warn(`${action} attempt ${attempt}/${retries} failed [${status || 'no-response'}]: ${detail}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      } else {
        logger.error(`${action} callback failed after ${retries} attempts → ${callbackUrl} [${status || 'no-response'}]: ${detail}`);
        pool.query(
          `UPDATE ondc_transactions SET status = 'failed'
           WHERE transaction_id = ? AND action = ? AND direction = 'out'`,
          [context?.transaction_id, action]
        ).catch(() => {});
      }
    }
  }
};

// Update ONDC order status in DB (also sets timestamp columns)
const updateOrderStatus = async (ondcOrderId, status) => {
  let extraSql = '';
  if (status === 'delivered') extraSql = ', delivered_at = NOW()';
  if (status === 'cancelled') extraSql = ', cancelled_at = NOW()';
  if (status === 'shipped')   extraSql = ', shipped_at = NOW()';

  await pool.query(
    `UPDATE ondc_orders SET status = ?, updated_at = NOW()${extraSql} WHERE ondc_order_id = ?`,
    [status, ondcOrderId]
  );
};

module.exports = { buildQuote, buildOrderObject, getTenantByBppId, sendCallback, updateOrderStatus };
