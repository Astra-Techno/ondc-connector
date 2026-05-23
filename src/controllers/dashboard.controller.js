const { pool } = require('../config/database');
const { success, error } = require('../utils/response');

const getStats = async (req, res) => {
  try {
    const tenant = req.tenant;

    const [[vendors]] = await pool.query(`
      SELECT COUNT(*) as total,
             SUM(status = 'active')  as active,
             SUM(status = 'pending') as pending
      FROM vendors WHERE tenant_id = ?
    `, [tenant.id]);

    const [[products]] = await pool.query(`
      SELECT COUNT(*) as total,
             SUM(ondc_sync_status = 'synced') as synced,
             SUM(ondc_sync_status = 'failed') as failed,
             SUM(is_active = 1)               as active
      FROM products WHERE tenant_id = ?
    `, [tenant.id]);

    const [[orders]] = await pool.query(`
      SELECT COUNT(*) as total,
             SUM(status = 'confirmed')  as confirmed,
             SUM(status = 'delivered')  as delivered,
             SUM(status = 'cancelled')  as cancelled,
             SUM(total_amount)          as revenue
      FROM ondc_orders WHERE tenant_id = ?
    `, [tenant.id]);

    const [[lastSync]] = await pool.query(`
      SELECT completed_at FROM sync_logs
      WHERE tenant_id = ? AND status = 'success'
      ORDER BY completed_at DESC LIMIT 1
    `, [tenant.id]);

    const [recentOrders] = await pool.query(`
      SELECT id, ondc_order_id, total_amount as amount, status, created_at
      FROM ondc_orders WHERE tenant_id = ?
      ORDER BY created_at DESC LIMIT 5
    `, [tenant.id]);

    const [ondcRows] = await pool.query(
      `SELECT * FROM tenant_ondc_config WHERE tenant_id = ? AND is_active = 1 LIMIT 1`,
      [tenant.id]
    );
    const ondc = ondcRows[0] || null;

    // Settlement summary
    let settlement = { pending: 0, processed: 0, this_month: 0 };
    try {
      const [[s]] = await pool.query(`
        SELECT
          SUM(CASE WHEN status = 'pending'   THEN seller_payout ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'processed' THEN seller_payout ELSE 0 END) as processed,
          SUM(CASE WHEN MONTH(created_at) = MONTH(NOW())
                    AND YEAR(created_at)  = YEAR(NOW())
                    THEN seller_payout ELSE 0 END)                          as this_month
        FROM settlements WHERE tenant_id = ?
      `, [tenant.id]);
      settlement = { pending: s.pending || 0, processed: s.processed || 0, this_month: s.this_month || 0 };
    } catch (e) {}

    // IGM summary
    let igm = { open: 0, in_progress: 0, resolved: 0 };
    try {
      const [[i]] = await pool.query(`
        SELECT SUM(status = 'open')        as open,
               SUM(status = 'in_progress') as in_progress,
               SUM(status = 'resolved')    as resolved
        FROM issue_grievances WHERE tenant_id = ?
      `, [tenant.id]);
      igm = { open: i.open || 0, in_progress: i.in_progress || 0, resolved: i.resolved || 0 };
    } catch (e) {}

    return success(res, {
      vendors: {
        total:   vendors.total   || 0,
        active:  vendors.active  || 0,
        pending: vendors.pending || 0,
      },
      products: {
        total:  products.total  || 0,
        synced: products.synced || 0,
        failed: products.failed || 0,
        active: products.active || 0,
      },
      orders: {
        total:     orders.total     || 0,
        confirmed: orders.confirmed || 0,
        delivered: orders.delivered || 0,
        cancelled: orders.cancelled || 0,
        revenue:   orders.revenue   || 0,
      },
      ondc: ondc ? {
        subscriber_id: ondc.subscriber_id,
        environment:   ondc.ondc_env,
        key_expiry:    ondc.key_valid_until,
        connected:     true,
      } : null,
      settlement,
      igm,
      recent_orders: recentOrders,
      last_sync:     lastSync?.completed_at || null,
    });
  } catch (err) {
    return error(res, err.message);
  }
};

const getSyncLogs = async (req, res) => {
  try {
    const { type, status, page = 1, per_page = 50 } = req.query;
    const limit  = parseInt(per_page);
    const offset = (parseInt(page) - 1) * limit;

    let where  = 'WHERE tenant_id = ?';
    const params = [req.tenant.id];

    if (type)   { where += ' AND sync_type = ?'; params.push(type); }
    if (status) { where += ' AND status = ?';    params.push(status); }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM sync_logs ${where}`, params
    );

    const [logs] = await pool.query(
      `SELECT * FROM sync_logs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return success(res, { logs, total, page: parseInt(page) });
  } catch (err) {
    return error(res, err.message);
  }
};

module.exports = { getStats, getSyncLogs };
