const { pool } = require('../config/database');
const { success, error, ack, nack } = require('../utils/response');
const logger = require('../utils/logger');
const fetch = require('node-fetch');

// Helper: extract fulfillment type/status from JSON fulfillment column
const parseFulfillment = (row) => {
  try {
    const ff = typeof row.fulfillment === 'string' ? JSON.parse(row.fulfillment) : row.fulfillment;
    if (Array.isArray(ff) && ff.length) {
      const primary = ff.find(f => f.type === 'Buyer-Delivery') || ff[0];
      return {
        fulfillment_type: primary.type || 'Delivery',
        fulfillment_status: primary.state?.descriptor?.code || null,
      };
    }
  } catch {}
  return { fulfillment_type: 'Delivery', fulfillment_status: null };
};

// Helper: extract payment type/status from JSON payment column
const parsePayment = (row) => {
  try {
    const p = typeof row.payment === 'string' ? JSON.parse(row.payment) : row.payment;
    if (p) return { payment_type: p.type || null, payment_status: p.status || p.collected_by || null };
  } catch {}
  return { payment_type: null, payment_status: null };
};

// Helper: normalize buyer info — handles both flat columns and buyer_info JSON
const parseBuyer = (row) => {
  if (row.buyer_name) return {}; // flat columns already present
  if (!row.buyer_info) return {};
  try {
    const b = typeof row.buyer_info === 'string' ? JSON.parse(row.buyer_info) : row.buyer_info;
    return {
      buyer_name: b?.name || null,
      buyer_phone: b?.phone || null,
      buyer_email: b?.email || null,
    };
  } catch {}
  return {};
};

// Get all orders
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

    // Enrich each order with parsed fulfillment/payment/buyer info
    let orders = rows.map(row => ({
      ...row,
      ...parseFulfillment(row),
      ...parsePayment(row),
      ...parseBuyer(row),
    }));

    // Client-side filter for fulfillment_type (stored in JSON, not a SQL column)
    if (fulfillment_type) {
      orders = orders.filter(o => o.fulfillment_type === fulfillment_type);
    }

    // Calculate revenue from returned rows
    const revenue = rows.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0);

    return success(res, { orders, total: count, revenue, page: parseInt(page), limit: realLimit });
  } catch (err) {
    return error(res, err.message);
  }
};

// Get single order (enriched with parsed fulfillment/payment)
const getOrder = async (req, res) => {
  try {
    const tenant = req.tenant;
    const [rows] = await pool.query(
      'SELECT * FROM ondc_orders WHERE tenant_id = ? AND ondc_order_id = ?',
      [tenant.id, req.params.order_id]
    );
    if (!rows.length) return error(res, 'Order not found', 404);
    const row = rows[0];
    return success(res, {
      ...row,
      ...parseFulfillment(row),
      ...parsePayment(row),
      ...parseBuyer(row),
    });
  } catch (err) {
    return error(res, err.message);
  }
};

// Resolve transaction_id for an order — handles both schema variants:
// 1. ondc_orders.ondc_transaction_id column (if present)
// 2. Fallback: extract from raw_payload JSON or look up via ondc_transactions table
const resolveTransactionId = async (tenantId, ondcOrderId) => {
  // Try direct column first (may not exist on older schemas)
  const [orderRows] = await pool.query(
    'SELECT * FROM ondc_orders WHERE tenant_id = ? AND ondc_order_id = ? LIMIT 1',
    [tenantId, ondcOrderId]
  );
  if (!orderRows.length) return { order: null, txnId: null };
  const order = orderRows[0];

  // 1. Direct column
  if (order.ondc_transaction_id) return { order, txnId: order.ondc_transaction_id };

  // 2. Extract from raw_payload JSON
  try {
    const raw = typeof order.raw_payload === 'string' ? JSON.parse(order.raw_payload) : order.raw_payload;
    if (raw?.context?.transaction_id) return { order, txnId: raw.context.transaction_id };
  } catch {}

  // 3. Look up from ondc_transactions by order ID in payload
  const [txnRows] = await pool.query(
    `SELECT transaction_id FROM ondc_transactions
     WHERE tenant_id = ? AND JSON_EXTRACT(request_payload, '$.message.order.id') = ?
     LIMIT 1`,
    [tenantId, ondcOrderId]
  );
  if (txnRows.length) return { order, txnId: txnRows[0].transaction_id };

  return { order, txnId: null };
};

// Get order fulfillment timeline from ondc_transactions
const getOrderTimeline = async (req, res) => {
  try {
    const tenant = req.tenant;
    const { order, txnId } = await resolveTransactionId(tenant.id, req.params.order_id);
    if (!order) return error(res, 'Order not found', 404);
    if (!txnId) return success(res, []);

    const [logs] = await pool.query(
      `SELECT action, direction, message_id, status, created_at,
              JSON_EXTRACT(request_payload, '$.message.order.state') as order_state,
              JSON_EXTRACT(request_payload, '$.message.order.fulfillments[0].state.descriptor.code') as fulfillment_state
       FROM ondc_transactions
       WHERE tenant_id = ? AND transaction_id = ?
       ORDER BY created_at ASC`,
      [tenant.id, txnId]
    );

    const timeline = logs.map(log => ({
      action: log.action,
      direction: log.direction,
      status: log.status,
      order_state: log.order_state ? JSON.parse(log.order_state) : null,
      fulfillment_state: log.fulfillment_state ? JSON.parse(log.fulfillment_state) : null,
      timestamp: log.created_at,
    }));

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

    // Redact signing keys and auth headers from context
    if (obj?.context) {
      if (obj.context.signing_private_key) obj.context.signing_private_key = '***';
      if (obj.context.authorization) obj.context.authorization = '***';
    }

    // Redact settlement bank details from payment
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
      // Redact payment transaction_id
      if (payment.params?.transaction_id) payment.params.transaction_id = '***';
    }

    // Mask billing PII (keep first initial + last 4 of phone for debugging)
    const billing = obj?.message?.order?.billing;
    if (billing) {
      if (billing.email) billing.email = billing.email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
      if (billing.phone) billing.phone = '******' + billing.phone.slice(-4);
      if (billing.name) billing.name = billing.name.charAt(0) + '***';
    }

    return obj;
  } catch { return null; }
};

// Get sanitized protocol logs for an order
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
       ORDER BY created_at ASC`,
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

// Update order status
const updateOrderStatus = async (req, res) => {
  try {
    const tenant = req.tenant;
    const { status, tracking_id, tracking_url, remarks } = req.body;

    const validStatuses = ['confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'];
    if (!validStatuses.includes(status)) {
      return error(res, `Invalid status. Valid values: ${validStatuses.join(', ')}`, 400);
    }

    const updateFields = { status, updated_at: new Date() };
    if (status === 'delivered') updateFields.delivered_at = new Date();
    if (status === 'cancelled') updateFields.cancelled_at = new Date();
    if (status === 'shipped') updateFields.shipped_at = new Date();

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

// Save incoming ONDC order and notify tenant
// Supports both DB schemas: live (buyer_info JSON, no transaction_id column)
// and extended (flat buyer columns, transaction_id column)
const saveONDCOrder = async (tenantId, orderData, rawPayload) => {
  try {
    const order = orderData.message?.order;
    const context = orderData.context;

    if (!order) return;

    // Get vendor
    const firstItem = order.items?.[0];
    const [vendor] = await pool.query(
      'SELECT * FROM vendors WHERE tenant_id = ? LIMIT 1',
      [tenantId]
    );

    // Detect schema: check if ondc_transaction_id column exists
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
      // Live schema: buyer_info JSON column, no transaction/message/bap columns
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
