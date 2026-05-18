const { pool } = require('../config/database');
const { success, error } = require('../utils/response');

const getStats = async (req, res) => {
  try {
    const tenant = req.tenant;

    const [[vendors]] = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(status = 'active') as active,
        SUM(status = 'pending') as pending
      FROM vendors WHERE tenant_id = ?
    `, [tenant.id]);

    const [[products]] = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(ondc_sync_status = 'synced') as synced,
        SUM(ondc_sync_status = 'failed') as failed,
        SUM(is_active = 1) as active
      FROM products WHERE tenant_id = ?
    `, [tenant.id]);

    const [[orders]] = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(status = 'confirmed') as confirmed,
        SUM(status = 'delivered') as delivered,
        SUM(status = 'cancelled') as cancelled,
        SUM(total_amount) as revenue
      FROM ondc_orders WHERE tenant_id = ?
    `, [tenant.id]);

    const [[lastSync]] = await pool.query(`
      SELECT completed_at FROM sync_logs 
      WHERE tenant_id = ? AND status = 'success'
      ORDER BY completed_at DESC LIMIT 1
    `, [tenant.id]);

    return success(res, {
      vendors: {
        total: vendors.total || 0,
        active: vendors.active || 0,
        pending: vendors.pending || 0
      },
      products: {
        total: products.total || 0,
        synced: products.synced || 0,
        failed: products.failed || 0,
        active: products.active || 0
      },
      orders: {
        total: orders.total || 0,
        confirmed: orders.confirmed || 0,
        delivered: orders.delivered || 0,
        cancelled: orders.cancelled || 0,
        revenue: orders.revenue || 0
      },
      last_sync: lastSync?.completed_at || null
    });
  } catch (err) {
    return error(res, err.message);
  }
};

const getSyncLogs = async (req, res) => {
  try {
    const { type, status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT * FROM sync_logs WHERE tenant_id = ?';
    const params = [req.tenant.id];

    if (type) { query += ' AND sync_type = ?'; params.push(type); }
    if (status) { query += ' AND status = ?'; params.push(status); }

    query += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [logs] = await pool.query(query, params);
    return success(res, logs);
  } catch (err) {
    return error(res, err.message);
  }
};

module.exports = { getStats, getSyncLogs };
