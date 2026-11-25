const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const logger = require('../utils/logger');
const { parseIgm2Issue } = require('../services/ondc/parseIgm2Issue');

const IGM_ACTIONS = ['issue', 'on_issue', 'issue_status', 'on_issue_status', 'on_update', 'on_status'];

// Mask PII for display — show first 2 + last 2 chars
const maskPhone = (p) => p && p.length > 4 ? p.slice(0, 2) + '***' + p.slice(-2) : p;
const maskEmail = (e) => {
  if (!e || !e.includes('@')) return e;
  const [local, domain] = e.split('@');
  return local.slice(0, 2) + '***@' + domain;
};

const getIssues = async (req, res) => {
  try {
    const { status, search, page = 1, per_page = 50 } = req.query;
    const limit  = parseInt(per_page);
    const offset = (parseInt(page) - 1) * limit;

    let where  = 'WHERE tenant_id = ?';
    const params = [req.tenant.id];

    if (status) { where += ' AND status = ?'; params.push(status); }
    if (search) {
      where += ' AND (issue_id LIKE ? OR order_id LIKE ? OR description LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM issue_grievances ${where}`, params
    );

    const [issues] = await pool.query(
      `SELECT id, tenant_id, transaction_id, issue_id, order_id, issue_type, category,
              sub_category, description, status, descriptor_code, resolution, remarks,
              complainant_name, complainant_phone, complainant_email,
              resolved_at, closed_at, created_at, updated_at
       FROM issue_grievances ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Mask PII in list view
    const masked = issues.map(i => ({
      ...i,
      complainant_phone: maskPhone(i.complainant_phone),
      complainant_email: maskEmail(i.complainant_email),
    }));

    // Status summary counts
    const [[summary]] = await pool.query(
      `SELECT
        SUM(status = 'open')        as open_count,
        SUM(status = 'in_progress') as in_progress_count,
        SUM(status = 'resolved')    as resolved_count,
        SUM(status = 'closed')      as closed_count
       FROM issue_grievances WHERE tenant_id = ?`,
      [req.tenant.id]
    );

    return success(res, {
      issues: masked,
      total,
      page: parseInt(page),
      summary: {
        open:        summary.open_count || 0,
        in_progress: summary.in_progress_count || 0,
        resolved:    summary.resolved_count || 0,
        closed:      summary.closed_count || 0,
      },
    });
  } catch (err) {
    return error(res, err.message);
  }
};

const getIssue = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM issue_grievances WHERE id = ? AND tenant_id = ?`,
      [req.params.id, req.tenant.id]
    );
    if (!rows.length) return error(res, 'Issue not found', 404);

    const row = rows[0];

    // Parse raw_payload for structured data
    let parsed = null;
    if (row.raw_payload) {
      try {
        const raw = typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload) : row.raw_payload;
        parsed = parseIgm2Issue(raw);
      } catch (e) {
        logger.warn('Failed to parse IGM raw_payload:', e.message);
      }
    }

    // Fetch protocol timeline from ondc_transactions
    let protocolTimeline = [];
    if (row.transaction_id) {
      const [txnRows] = await pool.query(
        `SELECT id, action, direction, message_id, status,
                request_payload, created_at
         FROM ondc_transactions
         WHERE tenant_id = ? AND transaction_id = ? AND action IN (?)
         ORDER BY created_at ASC, id ASC`,
        [req.tenant.id, row.transaction_id, IGM_ACTIONS]
      );
      protocolTimeline = txnRows.map(t => {
        // Extract issue status from payload for display
        let issueStatus = null;
        try {
          const p = typeof t.request_payload === 'string' ? JSON.parse(t.request_payload) : t.request_payload;
          issueStatus = p?.message?.issue?.status || null;
        } catch (_) {}
        return {
          id: t.id,
          action: t.action,
          direction: t.direction,
          message_id: t.message_id,
          status: t.status,
          issue_status: issueStatus,
          created_at: t.created_at,
        };
      });
    }

    // Fetch linked order summary (if exists)
    let linkedOrder = null;
    if (row.order_id) {
      const [orderRows] = await pool.query(
        `SELECT id, ondc_order_id, status, total_amount, buyer_name, created_at
         FROM ondc_orders
         WHERE tenant_id = ? AND (ondc_order_id = ? OR id = ?)
         LIMIT 1`,
        [req.tenant.id, row.order_id, row.order_id]
      );
      if (orderRows.length) {
        linkedOrder = {
          id:            orderRows[0].id,
          ondc_order_id: orderRows[0].ondc_order_id,
          status:        orderRows[0].status,
          total_amount:  orderRows[0].total_amount,
          buyer_name:    orderRows[0].buyer_name,
          created_at:    orderRows[0].created_at,
        };
      }
    }

    // Mask PII
    row.complainant_phone = maskPhone(row.complainant_phone);
    row.complainant_email = maskEmail(row.complainant_email);

    return success(res, {
      ...row,
      parsed,
      protocolTimeline,
      linkedOrder,
    });
  } catch (err) {
    return error(res, err.message);
  }
};

const updateIssue = async (req, res) => {
  try {
    const { status, resolution, remarks } = req.body;
    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];

    if (status && !validStatuses.includes(status)) {
      return error(res, `Invalid status. Use: ${validStatuses.join(', ')}`, 400);
    }

    await pool.query(
      `UPDATE issue_grievances
       SET status     = COALESCE(?, status),
           resolution = COALESCE(?, resolution),
           remarks    = COALESCE(?, remarks),
           updated_at = NOW()
       WHERE id = ? AND tenant_id = ?`,
      [status, resolution, remarks, req.params.id, req.tenant.id]
    );

    return success(res, null, 'Issue updated');
  } catch (err) {
    logger.error('updateIssue failed:', err.message);
    return error(res, err.message);
  }
};

module.exports = { getIssues, getIssue, updateIssue };
