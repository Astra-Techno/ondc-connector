const { pool } = require('../config/database');
const { success, error } = require('../utils/response');

const createWebhook = async (req, res) => {
  try {
    const tenant = req.tenant;
    const { event, url, secret } = req.body;

    const validEvents = ['order.confirmed', 'order.cancelled', 'order.returned', 'payment.received', 'igm.raised'];
    if (!validEvents.includes(event)) {
      return error(res, `Invalid event. Valid: ${validEvents.join(', ')}`, 400);
    }

    const [result] = await pool.query(
      'INSERT INTO webhooks (tenant_id, event, url, secret) VALUES (?, ?, ?, ?)',
      [tenant.id, event, url, secret || null]
    );

    return success(res, { id: result.insertId, event, url }, 'Webhook created', 201);
  } catch (err) {
    return error(res, err.message);
  }
};

const getWebhooks = async (req, res) => {
  try {
    const [webhooks] = await pool.query(
      'SELECT id, event, url, is_active, last_triggered_at, created_at FROM webhooks WHERE tenant_id = ?',
      [req.tenant.id]
    );
    return success(res, webhooks);
  } catch (err) {
    return error(res, err.message);
  }
};

const deleteWebhook = async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM webhooks WHERE tenant_id = ? AND id = ?',
      [req.tenant.id, req.params.id]
    );
    return success(res, null, 'Webhook deleted');
  } catch (err) {
    return error(res, err.message);
  }
};

module.exports = { createWebhook, getWebhooks, deleteWebhook };
