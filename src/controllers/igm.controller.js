const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const logger = require('../utils/logger');

const getIssues = async (req, res) => {
  try {
    const { status, page = 1, per_page = 50 } = req.query;
    const limit  = parseInt(per_page);
    const offset = (parseInt(page) - 1) * limit;

    let where  = 'WHERE tenant_id = ?';
    const params = [req.tenant.id];
    if (status) { where += ' AND status = ?'; params.push(status); }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM issue_grievances ${where}`, params
    );

    const [issues] = await pool.query(
      `SELECT * FROM issue_grievances ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return success(res, { issues, total, page: parseInt(page) });
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
    return success(res, rows[0]);
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
