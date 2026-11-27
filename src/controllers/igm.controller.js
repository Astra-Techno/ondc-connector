const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const logger = require('../utils/logger');
const { parseIgm2Issue } = require('../services/ondc/parseIgm2Issue');

const IGM_ACTIONS = ['issue', 'on_issue', 'issue_status', 'on_issue_status', 'on_update', 'on_status'];
const ALL_ORDER_ACTIONS = [
  'search', 'on_search', 'select', 'on_select', 'init', 'on_init',
  'confirm', 'on_confirm', 'status', 'on_status', 'cancel', 'on_cancel',
  'update', 'on_update', 'track', 'on_track', 'support', 'on_support',
  'issue', 'on_issue', 'issue_status', 'on_issue_status',
];

// Mask PII for display — show first 2 + last 2 chars
const maskPhone = (p) => p && p.length > 4 ? p.slice(0, 2) + '***' + p.slice(-2) : p;
const maskEmail = (e) => {
  if (!e || !e.includes('@')) return e;
  const [local, domain] = e.split('@');
  return local.slice(0, 2) + '***@' + domain;
};

// Map IGM protocol status to DB enum
const mapStatusToDb = (s) => {
  if (!s) return 'open';
  const upper = s.toUpperCase();
  if (upper === 'CLOSED') return 'closed';
  if (upper === 'RESOLVED') return 'resolved';
  if (['PROCESSING', 'NEED-MORE-INFO', 'RESOLUTION_PROPOSED', 'RESOLUTION_ACCEPTED',
       'RESOLUTION_REJECTED', 'ESCALATED', 'INFO_PROVIDED'].includes(upper)) return 'in_progress';
  if (upper === 'OPEN') return 'open';
  return 'open';
};

const getIssues = async (req, res) => {
  try {
    const { status, search, category, date_from, date_to, sort_by, sort_dir,
            has_rejection, has_escalation, has_evidence, final_outcome,
            page = 1, per_page = 50 } = req.query;
    const limit  = Math.min(parseInt(per_page) || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    let where  = 'WHERE tenant_id = ?';
    const params = [req.tenant.id];

    if (status) { where += ' AND status = ?'; params.push(status); }
    if (category) { where += ' AND descriptor_code = ?'; params.push(category); }
    if (date_from) { where += ' AND created_at >= ?'; params.push(date_from); }
    if (date_to) { where += ' AND created_at <= ?'; params.push(date_to + ' 23:59:59'); }
    if (search) {
      where += ' AND (issue_id LIKE ? OR order_id LIKE ? OR description LIKE ? OR descriptor_code LIKE ? OR item_id LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM issue_grievances ${where}`, params
    );

    // Safe sort columns
    const allowedSorts = ['created_at', 'updated_at', 'status', 'order_id', 'descriptor_code'];
    const orderCol = allowedSorts.includes(sort_by) ? sort_by : 'created_at';
    const orderDir = sort_dir?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const [issues] = await pool.query(
      `SELECT id, tenant_id, transaction_id, issue_id, order_id, issue_type, category,
              sub_category, description, status, descriptor_code, resolution, remarks,
              complainant_name, complainant_phone, complainant_email,
              item_id, provider_id, fulfillment_id,
              resolved_at, closed_at, raw_payload, created_at, updated_at
       FROM issue_grievances ${where}
       ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Enrich rows — parse raw_payload for workflow, outcome, and missing fields
    const enriched = issues.map(row => {
      let parsed = null;
      if (row.raw_payload) {
        try {
          const raw = typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload) : row.raw_payload;
          parsed = parseIgm2Issue(raw);
        } catch (_) {}
      }
      return {
        id: row.id,
        issue_id: row.issue_id,
        order_id: row.order_id || parsed?.orderId || null,
        descriptor_code: row.descriptor_code || parsed?.descriptorCode || null,
        category: row.category || parsed?.category || null,
        description: row.description || parsed?.shortDesc || null,
        status: row.status,
        item_id: row.item_id || parsed?.itemId || null,
        provider_id: row.provider_id || parsed?.providerId || null,
        complainant_name: maskPhone(row.complainant_name || parsed?.complainant?.name || null),
        complainant_phone: maskPhone(row.complainant_phone || parsed?.complainant?.phone || null),
        complainant_email: maskEmail(row.complainant_email || parsed?.complainant?.email || null),
        workflow: parsed?.workflow || 'Standard',
        final_outcome: parsed?.finalOutcome || 'Pending',
        has_rejection: parsed?.hasRejection || false,
        has_escalation: parsed?.hasEscalation || false,
        has_evidence: parsed?.hasEvidence || false,
        resolved_at: row.resolved_at,
        closed_at: row.closed_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });

    // Status summary counts (always unfiltered for the tenant)
    const [[summary]] = await pool.query(
      `SELECT
        SUM(status = 'open')        as open_count,
        SUM(status = 'in_progress') as in_progress_count,
        SUM(status = 'resolved')    as resolved_count,
        SUM(status = 'closed')      as closed_count
       FROM issue_grievances WHERE tenant_id = ?`,
      [req.tenant.id]
    );

    // Analytics: derive rejection/escalation/evidence counts from enriched list data
    // These are computed from parsed payloads, not stored DB columns
    const analytics = {
      rejection_cases: enriched.filter(r => r.has_rejection).length,
      escalated_cases: enriched.filter(r => r.has_escalation).length,
      evidence_cases: enriched.filter(r => r.has_evidence).length,
      is_filtered: !!(status || search || category || date_from || date_to),
    };

    // Distinct categories for filter dropdown
    const [catRows] = await pool.query(
      `SELECT DISTINCT descriptor_code FROM issue_grievances
       WHERE tenant_id = ? AND descriptor_code IS NOT NULL ORDER BY descriptor_code`,
      [req.tenant.id]
    );

    return success(res, {
      issues: enriched,
      total,
      page: Math.max(parseInt(page) || 1, 1),
      per_page: limit,
      summary: {
        open:        summary.open_count || 0,
        in_progress: summary.in_progress_count || 0,
        resolved:    summary.resolved_count || 0,
        closed:      summary.closed_count || 0,
      },
      analytics,
      categories: catRows.map(r => r.descriptor_code),
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

    // Fetch protocol timeline from ondc_transactions (all order events for this txn)
    let protocolTimeline = [];
    let igmTimeline = [];
    if (row.transaction_id) {
      const [txnRows] = await pool.query(
        `SELECT id, action, direction, message_id, status,
                request_payload, created_at
         FROM ondc_transactions
         WHERE tenant_id = ? AND transaction_id = ? AND action IN (?)
         ORDER BY created_at ASC, id ASC`,
        [req.tenant.id, row.transaction_id, ALL_ORDER_ACTIONS]
      );
      const mapRow = (t) => {
        let issueStatus = null;
        let ackStatus = t.status || null;
        try {
          const p = typeof t.request_payload === 'string' ? JSON.parse(t.request_payload) : t.request_payload;
          issueStatus = p?.message?.issue?.status || null;
        } catch (_) {}
        return {
          id: t.id,
          action: t.action,
          direction: t.direction,
          message_id: t.message_id,
          ack_status: ackStatus,
          issue_status: issueStatus,
          is_igm: IGM_ACTIONS.includes(t.action),
          created_at: t.created_at,
        };
      };
      protocolTimeline = txnRows.map(mapRow);
      igmTimeline = protocolTimeline.filter(t => t.is_igm);
    }

    // Fetch linked order summary (if exists)
    let linkedOrder = null;
    const lookupOrderId = row.order_id || parsed?.orderId;
    if (lookupOrderId) {
      const [orderRows] = await pool.query(
        `SELECT id, ondc_order_id, status, total_amount, created_at
         FROM ondc_orders
         WHERE tenant_id = ? AND (ondc_order_id = ? OR id = ?)
         LIMIT 1`,
        [req.tenant.id, lookupOrderId, lookupOrderId]
      );
      if (orderRows.length) {
        linkedOrder = {
          id:            orderRows[0].id,
          ondc_order_id: orderRows[0].ondc_order_id,
          status:        orderRows[0].status,
          total_amount:  orderRows[0].total_amount,
          created_at:    orderRows[0].created_at,
        };
      }
    }

    // Mask PII
    row.complainant_phone = maskPhone(row.complainant_phone);
    row.complainant_email = maskEmail(row.complainant_email);

    // Strip raw_payload from main response (sent via parsed + raw endpoint)
    const { raw_payload, ...rowWithoutRaw } = row;

    return success(res, {
      ...rowWithoutRaw,
      parsed,
      protocolTimeline,
      igmTimeline,
      linkedOrder,
      has_raw_payload: !!raw_payload,
    });
  } catch (err) {
    return error(res, err.message);
  }
};

const getRawPayload = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT raw_payload FROM issue_grievances WHERE id = ? AND tenant_id = ?`,
      [req.params.id, req.tenant.id]
    );
    if (!rows.length) return error(res, 'Issue not found', 404);
    const raw = rows[0].raw_payload;
    if (!raw) return success(res, null);
    try {
      return success(res, typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch (_) {
      return success(res, raw);
    }
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

// Backfill existing rows using their raw_payload
const backfillIssues = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, raw_payload, status FROM issue_grievances
       WHERE tenant_id = ? AND raw_payload IS NOT NULL`,
      [req.tenant.id]
    );

    let updated = 0;
    for (const row of rows) {
      try {
        const raw = typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload) : row.raw_payload;
        const parsed = parseIgm2Issue(raw);
        if (!parsed.issueId) continue;

        const dbStatus = mapStatusToDb(parsed.status);

        await pool.query(
          `UPDATE issue_grievances SET
            order_id = COALESCE(?, order_id),
            descriptor_code = COALESCE(?, descriptor_code),
            category = COALESCE(?, category),
            description = COALESCE(?, description),
            complainant_name = COALESCE(?, complainant_name),
            complainant_phone = COALESCE(?, complainant_phone),
            complainant_email = COALESCE(?, complainant_email),
            item_id = COALESCE(?, item_id),
            provider_id = COALESCE(?, provider_id),
            fulfillment_id = COALESCE(?, fulfillment_id),
            resolved_at = COALESCE(?, resolved_at),
            closed_at = COALESCE(?, closed_at),
            status = ?
           WHERE id = ?`,
          [
            parsed.orderId, parsed.descriptorCode, parsed.category,
            parsed.shortDesc, parsed.complainant?.name,
            parsed.complainant?.phone, parsed.complainant?.email,
            parsed.itemId, parsed.providerId, parsed.fulfillmentId,
            parsed.resolvedAt, parsed.closedAt,
            dbStatus, row.id
          ]
        );
        updated++;
      } catch (e) {
        logger.warn(`Backfill failed for issue ${row.id}:`, e.message);
      }
    }

    return success(res, { total: rows.length, updated }, `Backfilled ${updated}/${rows.length} issues`);
  } catch (err) {
    return error(res, err.message);
  }
};

// Diagnostic: show table columns and row count
const diagTable = async (req, res) => {
  try {
    const [cols] = await pool.query(`SHOW COLUMNS FROM issue_grievances`);
    const [[{ cnt }]] = await pool.query(
      `SELECT COUNT(*) as cnt FROM issue_grievances WHERE tenant_id = ?`, [req.tenant.id]);
    return success(res, {
      columns: cols.map(c => ({ field: c.Field, type: c.Type, nullable: c.Null, key: c.Key })),
      row_count: cnt,
    });
  } catch (err) {
    return error(res, err.message);
  }
};

module.exports = { getIssues, getIssue, getRawPayload, updateIssue, backfillIssues, diagTable };
