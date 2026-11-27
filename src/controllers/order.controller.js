const { pool } = require('../config/database');
const { success, error, ack, nack } = require('../utils/response');
const logger = require('../utils/logger');
const fetch = require('node-fetch');

// ── Helpers: parse JSON columns (MySQL JSON type returns objects, TEXT returns strings) ──

const safeParseJSON = (val) => {
  if (!val) return null;
  if (typeof val === 'object') return val; // already parsed (MySQL JSON column)
  try { return JSON.parse(val); } catch { return null; }
};

// Extract fulfillment type and status from the fulfillment JSON column
const parseFulfillment = (row) => {
  try {
    const ff = safeParseJSON(row.fulfillment);
    if (Array.isArray(ff) && ff.length) {
      const primary = ff.find(f => f.type === 'Buyer-Delivery') || ff[0];
      return {
        fulfillment_type: primary.type || 'Delivery',
        fulfillment_id: primary.id || null,
        fulfillment_status: primary.state?.descriptor?.code || null,
        fulfillments: ff,
      };
    }
  } catch {}
  return { fulfillment_type: 'Delivery', fulfillment_id: null, fulfillment_status: null, fulfillments: [] };
};

// Extract payment type and status
const parsePayment = (row) => {
  try {
    const p = safeParseJSON(row.payment);
    if (p) return { payment_type: p.type || null, payment_status: p.status || p.collected_by || null };
  } catch {}
  return { payment_type: null, payment_status: null };
};

// Normalize buyer info — handles both flat columns and buyer_info JSON
const parseBuyer = (row) => {
  if (row.buyer_name) return {};
  if (!row.buyer_info) return {};
  try {
    const b = safeParseJSON(row.buyer_info);
    return {
      buyer_name: b?.name || null,
      buyer_phone: b?.phone || null,
      buyer_email: b?.email || null,
    };
  } catch {}
  return {};
};

// Extract items as an array (handles both JSON object and string)
const parseItems = (row) => {
  const items = safeParseJSON(row.items);
  return Array.isArray(items) ? items : [];
};

// Extract identifiers from raw_payload.context (transaction_id, bap_id, provider, etc.)
const parseContext = (row) => {
  try {
    const raw = safeParseJSON(row.raw_payload);
    const ctx = raw?.context || {};
    const order = raw?.message?.order || {};
    return {
      transaction_id: row.ondc_transaction_id || ctx.transaction_id || null,
      bap_id: row.bap_id || ctx.bap_id || null,
      bap_uri: row.bap_uri || ctx.bap_uri || null,
      provider_id: order.provider?.id || null,
      provider_name: order.provider?.descriptor?.name || null,
    };
  } catch {}
  return { transaction_id: null, bap_id: null, bap_uri: null, provider_id: null, provider_name: null };
};

// Extract delivery address from fulfillment[].end.location.address
const parseDeliveryAddress = (row) => {
  try {
    const ff = safeParseJSON(row.fulfillment);
    if (Array.isArray(ff) && ff.length) {
      const primary = ff.find(f => f.type === 'Buyer-Delivery') || ff[0];
      const addr = primary?.end?.location?.address;
      if (addr) return addr;
    }
    // Fallback: delivery_address column (extended schema)
    if (row.delivery_address) return safeParseJSON(row.delivery_address);
  } catch {}
  return null;
};

// Enrich a raw DB row into the full API response shape
const enrichOrder = (row) => {
  const items = parseItems(row);
  const ctx = parseContext(row);
  const ff = parseFulfillment(row);
  const pay = parsePayment(row);
  const buyer = parseBuyer(row);
  const address = parseDeliveryAddress(row);

  return {
    ...row,
    // Parsed fields
    items_parsed: items,
    items_count: items.length,
    items_units: items.reduce((s, i) => s + (i.quantity?.count || i.quantity || 1), 0),
    // Context / identifiers
    transaction_id: ctx.transaction_id,
    bap_id: ctx.bap_id,
    bap_uri: ctx.bap_uri,
    provider_id: ctx.provider_id,
    provider_name: ctx.provider_name,
    // Fulfillment
    ...ff,
    // Payment
    ...pay,
    // Buyer
    ...buyer,
    // Address
    delivery_address_parsed: address,
  };
};

// ── API Handlers ──

// GET /orders — list all orders with filters
const getOrders = async (req, res) => {
  try {
    const tenant = req.tenant;
    const { status, fulfillment_type, from, to, page = 1, limit = 50, per_page } = req.query;
    const realLimit = parseInt(per_page || limit);
    const offset = (parseInt(page) - 1) * realLimit;

    let query = 'SELECT * FROM ondc_orders WHERE tenant_id = ?';
    let countQuery = 'SELECT COUNT(*) as count FROM ondc_orders WHERE tenant_id = ?';
    const params = [tenant.id];
    const countParams = [tenant.id];

    if (status) {
      query += ' AND status = ?'; params.push(status);
      countQuery += ' AND status = ?'; countParams.push(status);
    }
    if (from) {
      query += ' AND created_at >= ?'; params.push(from);
      countQuery += ' AND created_at >= ?'; countParams.push(from);
    }
    if (to) {
      query += ' AND created_at <= ?'; params.push(to);
      countQuery += ' AND created_at <= ?'; countParams.push(to);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(realLimit, offset);

    const [rows] = await pool.query(query, params);
    const [[{ count }]] = await pool.query(countQuery, countParams);

    // Batch-resolve latest fulfillment status from ondc_transactions to avoid N+1
    // Collect all order IDs that have raw_payload with transaction_id
    const txnMap = {};
    for (const row of rows) {
      const ctx = parseContext(row);
      if (ctx.transaction_id) txnMap[ctx.transaction_id] = [];
    }
    const txnIds = Object.keys(txnMap);
    if (txnIds.length) {
      try {
        const placeholders = txnIds.map(() => '?').join(',');
        const [txnRows] = await pool.query(
          `SELECT transaction_id,
                  JSON_UNQUOTE(JSON_EXTRACT(request_payload, '$.message.order.fulfillments[0].state.descriptor.code')) as ff_state,
                  JSON_UNQUOTE(JSON_EXTRACT(request_payload, '$.message.order.state')) as order_state,
                  created_at
           FROM ondc_transactions
           WHERE tenant_id = ? AND transaction_id IN (${placeholders})
             AND direction = 'outbound'
             AND JSON_EXTRACT(request_payload, '$.message.order.fulfillments[0].state.descriptor.code') IS NOT NULL
           ORDER BY created_at ASC`,
          [tenant.id, ...txnIds]
        );
        for (const t of txnRows) {
          if (!txnMap[t.transaction_id]) txnMap[t.transaction_id] = [];
          txnMap[t.transaction_id].push({ ff_state: t.ff_state, order_state: t.order_state });
        }
      } catch (e) {
        logger.warn(`Batch fulfillment status lookup failed: ${e.message}`);
      }
    }

    let orders = rows.map(row => {
      const enriched = enrichOrder(row);
      // Override fulfillment_status with the latest from transactions
      const ctx = parseContext(row);
      if (ctx.transaction_id && txnMap[ctx.transaction_id]?.length) {
        const events = txnMap[ctx.transaction_id];
        enriched.fulfillment_status = events[events.length - 1].ff_state;
      }
      return enriched;
    });

    // Client-side filter for fulfillment_type (stored in JSON, not a SQL column)
    if (fulfillment_type) {
      orders = orders.filter(o => o.fulfillment_type === fulfillment_type);
    }

    const revenue = rows.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0);

    return success(res, { orders, total: count, revenue, page: parseInt(page), limit: realLimit });
  } catch (err) {
    return error(res, err.message);
  }
};

// GET /orders/:order_id — single order detail
const getOrder = async (req, res) => {
  try {
    const tenant = req.tenant;
    const [rows] = await pool.query(
      'SELECT * FROM ondc_orders WHERE tenant_id = ? AND ondc_order_id = ?',
      [tenant.id, req.params.order_id]
    );
    if (!rows.length) return error(res, 'Order not found', 404);
    const enriched = enrichOrder(rows[0]);

    // Resolve latest fulfillment status from transactions
    if (enriched.transaction_id) {
      try {
        const [txnRows] = await pool.query(
          `SELECT JSON_UNQUOTE(JSON_EXTRACT(request_payload, '$.message.order.fulfillments[0].state.descriptor.code')) as ff_state
           FROM ondc_transactions
           WHERE tenant_id = ? AND transaction_id = ?
             AND direction = 'outbound'
             AND JSON_EXTRACT(request_payload, '$.message.order.fulfillments[0].state.descriptor.code') IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
          [tenant.id, enriched.transaction_id]
        );
        if (txnRows.length && txnRows[0].ff_state) {
          enriched.fulfillment_status = txnRows[0].ff_state;
        }
      } catch {}
    }

    return success(res, enriched);
  } catch (err) {
    return error(res, err.message);
  }
};

// Resolve transaction_id for an order — handles both schema variants
const resolveTransactionId = async (tenantId, ondcOrderId) => {
  const [orderRows] = await pool.query(
    'SELECT * FROM ondc_orders WHERE tenant_id = ? AND ondc_order_id = ? LIMIT 1',
    [tenantId, ondcOrderId]
  );
  if (!orderRows.length) return { order: null, txnId: null };
  const order = orderRows[0];

  // 1. Direct column (extended schema)
  if (order.ondc_transaction_id) return { order, txnId: order.ondc_transaction_id };

  // 2. Extract from raw_payload JSON
  try {
    const raw = safeParseJSON(order.raw_payload);
    if (raw?.context?.transaction_id) return { order, txnId: raw.context.transaction_id };
  } catch {}

  // 3. Look up from ondc_transactions by order ID in payload
  try {
    const [txnRows] = await pool.query(
      `SELECT transaction_id FROM ondc_transactions
       WHERE tenant_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(request_payload, '$.message.order.id')) = ?
       LIMIT 1`,
      [tenantId, ondcOrderId]
    );
    if (txnRows.length) return { order, txnId: txnRows[0].transaction_id };
  } catch {}

  return { order, txnId: null };
};

// GET /orders/:order_id/timeline — fulfillment timeline from ondc_transactions
const getOrderTimeline = async (req, res) => {
  try {
    const tenant = req.tenant;
    const { order, txnId } = await resolveTransactionId(tenant.id, req.params.order_id);
    if (!order) return error(res, 'Order not found', 404);
    if (!txnId) return success(res, []);

    const [logs] = await pool.query(
      `SELECT action, direction, message_id, status, created_at,
              JSON_UNQUOTE(JSON_EXTRACT(request_payload, '$.message.order.state')) as order_state,
              JSON_UNQUOTE(JSON_EXTRACT(request_payload, '$.message.order.fulfillments[0].state.descriptor.code')) as fulfillment_state,
              JSON_UNQUOTE(JSON_EXTRACT(request_payload, '$.message.order.fulfillments[0].id')) as fulfillment_id,
              JSON_UNQUOTE(JSON_EXTRACT(request_payload, '$.message.order.fulfillments[0].type')) as fulfillment_type
       FROM ondc_transactions
       WHERE tenant_id = ? AND transaction_id = ?
       ORDER BY created_at ASC, id ASC`,
      [tenant.id, txnId]
    );

    const timeline = logs.map(log => ({
      action: log.action,
      direction: log.direction,
      status: log.status,
      order_state: log.order_state || null,
      fulfillment_state: log.fulfillment_state || null,
      fulfillment_id: log.fulfillment_id || null,
      fulfillment_type: log.fulfillment_type || null,
      timestamp: log.created_at,
    }));

    if (!timeline.length && txnId) {
      return success(res, [], 'No timeline events found despite having transaction_id — possible payload structure mismatch');
    }

    return success(res, timeline);
  } catch (err) {
    return error(res, err.message);
  }
};

// Sanitize payloads: redact signing keys, bank details, settlement info, auth headers
const sanitizePayload = (payload) => {
  if (!payload) return null;
  try {
    const obj = typeof payload === 'string' ? JSON.parse(payload) : JSON.parse(JSON.stringify(payload));

    if (obj?.context) {
      if (obj.context.signing_private_key) obj.context.signing_private_key = '***';
      if (obj.context.authorization) obj.context.authorization = '***';
    }

    const payment = obj?.message?.order?.payment;
    if (payment) {
      const details = payment['@ondc/org/settlement_details'];
      if (Array.isArray(details)) {
        for (const d of details) {
          if (d.settlement_bank_account_no) d.settlement_bank_account_no = '****' + d.settlement_bank_account_no.slice(-4);
          if (d.settlement_ifsc_code) d.settlement_ifsc_code = d.settlement_ifsc_code.slice(0, 4) + '****';
          if (d.beneficiary_name) d.beneficiary_name = '***';
          if (d.bank_name) d.bank_name = '***';
          if (d.branch_name) d.branch_name = '***';
          if (d.upi_address) d.upi_address = '***';
        }
      }
      if (payment.params?.transaction_id) payment.params.transaction_id = '***';
    }

    const billing = obj?.message?.order?.billing;
    if (billing) {
      if (billing.email) billing.email = billing.email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
      if (billing.phone) billing.phone = '******' + billing.phone.slice(-4);
      if (billing.name) billing.name = billing.name.charAt(0) + '***';
    }

    return obj;
  } catch { return null; }
};

// GET /orders/:order_id/logs — sanitized protocol logs
const getOrderLogs = async (req, res) => {
  try {
    const tenant = req.tenant;
    const { order, txnId } = await resolveTransactionId(tenant.id, req.params.order_id);
    if (!order) return error(res, 'Order not found', 404);
    if (!txnId) return success(res, []);

    const [logs] = await pool.query(
      `SELECT id, action, direction, message_id, status, created_at, request_payload, response_payload
       FROM ondc_transactions
       WHERE tenant_id = ? AND transaction_id = ?
       ORDER BY created_at ASC, id ASC`,
      [tenant.id, txnId]
    );

    const sanitized = logs.map(log => ({
      id: log.id,
      action: log.action,
      direction: log.direction,
      message_id: log.message_id,
      status: log.status,
      timestamp: log.created_at,
      request_payload: sanitizePayload(log.request_payload),
      response_payload: sanitizePayload(log.response_payload),
    }));

    return success(res, sanitized);
  } catch (err) {
    return error(res, err.message);
  }
};

// PUT /orders/:order_id/status — update order status
const updateOrderStatus = async (req, res) => {
  try {
    const tenant = req.tenant;
    const { status, tracking_id, tracking_url, remarks } = req.body;

    const validStatuses = ['confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'];
    if (!validStatuses.includes(status)) {
      return error(res, `Invalid status. Valid values: ${validStatuses.join(', ')}`, 400);
    }

    await pool.query(
      'UPDATE ondc_orders SET status = ?, updated_at = NOW() WHERE tenant_id = ? AND ondc_order_id = ?',
      [status, tenant.id, req.params.order_id]
    );

    logger.info(`Order ${req.params.order_id} updated to ${status}`);
    return success(res, null, 'Order status updated');
  } catch (err) {
    return error(res, err.message);
  }
};

// Save incoming ONDC order — supports both live and extended DB schemas
const saveONDCOrder = async (tenantId, orderData, rawPayload) => {
  try {
    const order = orderData.message?.order;
    const context = orderData.context;

    if (!order) return;

    const [vendor] = await pool.query(
      'SELECT * FROM vendors WHERE tenant_id = ? LIMIT 1',
      [tenantId]
    );

    // Detect schema
    let hasExtendedSchema = false;
    try {
      const [cols] = await pool.query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ondc_orders' AND COLUMN_NAME = 'ondc_transaction_id'"
      );
      hasExtendedSchema = cols.length > 0;
    } catch {}

    if (hasExtendedSchema) {
      await pool.query(`
        INSERT INTO ondc_orders
          (tenant_id, vendor_id, ondc_order_id, ondc_transaction_id, ondc_message_id,
           bap_id, bap_uri, status, total_amount, currency,
           buyer_name, buyer_phone, buyer_email, delivery_address,
           delivery_city, delivery_pincode, items, fulfillment, payment, quote, raw_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = 'confirmed', updated_at = NOW()
      `, [
        tenantId,
        vendor.length ? vendor[0].id : null,
        order.id,
        context?.transaction_id,
        context?.message_id,
        context?.bap_id,
        context?.bap_uri,
        order.quote?.price?.value || 0,
        order.billing?.name,
        order.billing?.phone,
        order.billing?.email,
        JSON.stringify(order.fulfillments?.[0]?.end?.location?.address),
        order.fulfillments?.[0]?.end?.location?.address?.city,
        order.fulfillments?.[0]?.end?.location?.address?.area_code,
        JSON.stringify(order.items),
        JSON.stringify(order.fulfillments),
        JSON.stringify(order.payment),
        JSON.stringify(order.quote),
        JSON.stringify(rawPayload)
      ]);
    } else {
      const buyerInfo = order.billing ? {
        name: order.billing.name,
        phone: order.billing.phone,
        email: order.billing.email,
        address: order.fulfillments?.[0]?.end?.location?.address,
      } : null;

      await pool.query(`
        INSERT INTO ondc_orders
          (tenant_id, vendor_id, ondc_order_id, status, total_amount,
           buyer_info, items, fulfillment, payment, raw_payload)
        VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = 'confirmed', updated_at = NOW(),
          buyer_info = VALUES(buyer_info), items = VALUES(items),
          fulfillment = VALUES(fulfillment), payment = VALUES(payment),
          raw_payload = VALUES(raw_payload)
      `, [
        tenantId,
        vendor.length ? vendor[0].id : null,
        order.id,
        order.quote?.price?.value || 0,
        JSON.stringify(buyerInfo),
        JSON.stringify(order.items),
        JSON.stringify(order.fulfillments),
        JSON.stringify(order.payment),
        JSON.stringify(rawPayload)
      ]);
    }

    // Send webhook to tenant
    await sendWebhook(tenantId, 'order.confirmed', {
      ondc_order_id: order.id,
      transaction_id: context?.transaction_id,
      bap_id: context?.bap_id,
      status: 'confirmed',
      items: order.items,
      buyer: order.billing,
      delivery_address: order.fulfillments?.[0]?.end?.location?.address,
      payment: order.payment,
      quote: order.quote
    });

    logger.info(`ONDC order saved: ${order.id}`);
  } catch (err) {
    logger.error('Save ONDC order failed:', err.message);
  }
};

// Send webhook to tenant
const sendWebhook = async (tenantId, event, data) => {
  try {
    const [webhooks] = await pool.query(
      'SELECT * FROM webhooks WHERE tenant_id = ? AND event = ? AND is_active = 1',
      [tenantId, event]
    );

    for (const webhook of webhooks) {
      try {
        const payload = {
          event,
          timestamp: new Date().toISOString(),
          order: data
        };

        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': webhook.secret || ''
          },
          body: JSON.stringify(payload),
          timeout: 10000
        });

        await pool.query(`
          INSERT INTO webhook_logs (tenant_id, webhook_id, event, payload, response_code, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [tenantId, webhook.id, event, JSON.stringify(payload), response.status, response.ok ? 'success' : 'failed']);

        logger.info(`Webhook sent to ${webhook.url}: ${response.status}`);
      } catch (err) {
        logger.error(`Webhook failed for ${webhook.url}:`, err.message);
        await pool.query(`
          INSERT INTO webhook_logs (tenant_id, webhook_id, event, payload, status)
          VALUES (?, ?, ?, ?, 'failed')
        `, [tenantId, webhook.id, event, JSON.stringify(data)]);
      }
    }
  } catch (err) {
    logger.error('Send webhook failed:', err.message);
  }
};

module.exports = { getOrders, getOrder, getOrderTimeline, getOrderLogs, updateOrderStatus, saveONDCOrder, sendWebhook };
