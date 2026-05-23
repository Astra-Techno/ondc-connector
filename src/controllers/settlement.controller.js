const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const { processPayoutViaCashfree } = require('../services/settlement.service');
const logger = require('../utils/logger');

const getSettlements = async (req, res) => {
  try {
    const { status, vendor_id, from, to, page = 1, per_page = 50 } = req.query;
    const limit  = parseInt(per_page);
    const offset = (parseInt(page) - 1) * limit;

    let where  = 'WHERE s.tenant_id = ?';
    const params = [req.tenant.id];

    if (status)    { where += ' AND s.status = ?';    params.push(status); }
    if (vendor_id) { where += ' AND s.vendor_id = ?'; params.push(vendor_id); }
    if (from)      { where += ' AND s.created_at >= ?'; params.push(from); }
    if (to)        { where += ' AND s.created_at <= ?'; params.push(to); }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM settlements s ${where}`, params
    );

    const [settlements] = await pool.query(`
      SELECT s.*, v.business_name as vendor_name,
             o.buyer_name, o.buyer_email
      FROM settlements s
      LEFT JOIN vendors v     ON v.id = s.vendor_id
      LEFT JOIN ondc_orders o ON o.id = s.order_id
      ${where}
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return success(res, { settlements, total, page: parseInt(page) });
  } catch (err) {
    return error(res, err.message);
  }
};

const getSettlementById = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.*, v.business_name as vendor_name,
             v.bank_account, v.bank_ifsc,
             o.buyer_name, o.buyer_email,
             o.ondc_order_id, o.total_amount as order_total
      FROM settlements s
      LEFT JOIN vendors v     ON v.id = s.vendor_id
      LEFT JOIN ondc_orders o ON o.id = s.order_id
      WHERE s.id = ? AND s.tenant_id = ?
    `, [req.params.id, req.tenant.id]);

    if (!rows.length) return error(res, 'Settlement not found', 404);
    return success(res, rows[0]);
  } catch (err) {
    return error(res, err.message);
  }
};

const processSettlement = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM settlements WHERE id = ? AND tenant_id = ?`,
      [req.params.id, req.tenant.id]
    );
    if (!rows.length) return error(res, 'Settlement not found', 404);

    const settlement = rows[0];
    if (settlement.status !== 'pending') {
      return error(res, `Settlement already ${settlement.status}`, 400);
    }

    const result = await processPayoutViaCashfree(settlement);
    return success(res, result, 'Payout initiated');
  } catch (err) {
    logger.error('processSettlement failed:', err.message);
    return error(res, err.message);
  }
};

const getSettlementStats = async (req, res) => {
  try {
    const [[stats]] = await pool.query(`
      SELECT
        SUM(CASE WHEN status = 'pending'   THEN seller_payout ELSE 0 END) as pending_amount,
        SUM(CASE WHEN status = 'processed' THEN seller_payout ELSE 0 END) as processed_amount,
        SUM(CASE WHEN status = 'failed'    THEN seller_payout ELSE 0 END) as failed_amount,
        SUM(CASE WHEN MONTH(created_at) = MONTH(NOW())
                  AND YEAR(created_at)  = YEAR(NOW())
                  THEN seller_payout ELSE 0 END)                          as this_month,
        COUNT(*) as total_count
      FROM settlements WHERE tenant_id = ?
    `, [req.tenant.id]);

    return success(res, {
      pending_amount:   stats.pending_amount   || 0,
      processed_amount: stats.processed_amount || 0,
      failed_amount:    stats.failed_amount    || 0,
      this_month:       stats.this_month       || 0,
      total_count:      stats.total_count      || 0,
    });
  } catch (err) {
    return error(res, err.message);
  }
};

const generateSettlementReport = async (req, res) => {
  try {
    const { from, to } = req.query;
    let where  = 'WHERE s.tenant_id = ?';
    const params = [req.tenant.id];
    if (from) { where += ' AND s.created_at >= ?'; params.push(from); }
    if (to)   { where += ' AND s.created_at <= ?'; params.push(to); }

    const [rows] = await pool.query(`
      SELECT s.id, o.ondc_order_id, v.business_name as vendor_name,
             s.total_amount, s.buyer_app_fee, s.platform_commission,
             s.seller_payout, s.status, s.utr_number, s.created_at, s.processed_at
      FROM settlements s
      LEFT JOIN vendors v     ON v.id = s.vendor_id
      LEFT JOIN ondc_orders o ON o.id = s.order_id
      ${where}
      ORDER BY s.created_at DESC
    `, params);

    const csv = [
      'Settlement ID,Order ID,Vendor,Total Amount,Buyer App Fee,Platform Commission,Seller Payout,Status,UTR,Date',
      ...rows.map(r => [
        r.id,
        r.ondc_order_id        || '',
        `"${r.vendor_name     || ''}"`,
        r.total_amount,
        r.buyer_app_fee,
        r.platform_commission,
        r.seller_payout,
        r.status,
        r.utr_number           || '',
        new Date(r.created_at).toLocaleDateString('en-IN'),
      ].join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="settlements-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    return error(res, err.message);
  }
};

module.exports = {
  getSettlements,
  getSettlementById,
  processSettlement,
  getSettlementStats,
  generateSettlementReport,
};
