const { pool } = require('../config/database');
const { success, error, ack, nack } = require('../utils/response');
const logger = require('../utils/logger');
const fetch = require('node-fetch');

// Get all orders
const getOrders = async (req, res) => {
  try {
    const tenant = req.tenant;
    const { status, vendor_id, from, to, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT * FROM ondc_orders WHERE tenant_id = ?';
    const params = [tenant.id];

    if (status) { query += ' AND status = ?'; params.push(status); }
    if (from) { query += ' AND created_at >= ?'; params.push(from); }
    if (to) { query += ' AND created_at <= ?'; params.push(to); }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [orders] = await pool.query(query, params);
    const [[{ count }]] = await pool.query('SELECT COUNT(*) as count FROM ondc_orders WHERE tenant_id = ?', [tenant.id]);

    return success(res, { orders, total: count, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    return error(res, err.message);
  }
};

// Get single order
const getOrder = async (req, res) => {
  try {
    const tenant = req.tenant;
    const [rows] = await pool.query(
      'SELECT * FROM ondc_orders WHERE tenant_id = ? AND ondc_order_id = ?',
      [tenant.id, req.params.order_id]
    );
    if (!rows.length) return error(res, 'Order not found', 404);
    return success(res, rows[0]);
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

    const [result] = await pool.query(`
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

module.exports = { getOrders, getOrder, updateOrderStatus, saveONDCOrder, sendWebhook };
