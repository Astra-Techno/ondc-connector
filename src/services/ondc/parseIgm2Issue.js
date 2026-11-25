// parseIgm2Issue — safely extract structured fields from an IGM 2.0 (or 1.0) raw payload.
// Pure function, no side effects. Returns null for any field that cannot be resolved.

/**
 * @param {Object} rawPayload  — the full { context, message: { issue: {...} } } object
 * @returns {Object} parsed fields
 */
function parseIgm2Issue(rawPayload) {
  const ctx   = rawPayload?.context || {};
  const issue = rawPayload?.message?.issue || {};
  const isV2  = Array.isArray(issue.actions);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const refOf = (type) => {
    if (isV2 && Array.isArray(issue.refs)) {
      return issue.refs.find(r => r.ref_type === type)?.ref_id || null;
    }
    if (type === 'ORDER') return issue.order_details?.id || issue.order_id || null;
    return null;
  };

  const orderId       = refOf('ORDER');
  const providerId    = refOf('PROVIDER');
  const fulfillmentId = refOf('FULFILLMENT');
  const itemId        = refOf('ITEM');

  // ── Descriptor ────────────────────────────────────────────────────────────
  const descriptorCode = issue.descriptor?.code || null;
  const shortDesc      = issue.descriptor?.short_desc || issue.description || null;
  const longDesc       = issue.descriptor?.long_desc || null;
  const images         = Array.isArray(issue.descriptor?.images) ? issue.descriptor.images : [];

  // ── Category / type ───────────────────────────────────────────────────────
  const category    = issue.category || descriptorCode || null;
  const subCategory = issue.sub_category || null;
  const issueType   = issue.issue_type || 'ISSUE';

  // ── Actor role labels ─────────────────────────────────────────────────────
  const ROLE_LABELS = {
    CONSUMER:          'Consumer',
    INTERFACING_NP:    'Buyer NP (Interfacing)',
    COUNTERPARTY_NP:   'Seller NP (Counterparty)',
    COUNTERPARTY_NP_GRO: 'Grievance Officer (SNP)',
    INTERFACING_NP_GRO:  'Grievance Officer (BNP)',
    CASCADED_NP:       'Logistics NP',
  };

  // ── Actors (all, with org and role label) ─────────────────────────────────
  const actors = (issue.actors || []).map(a => ({
    id:        a.id || null,
    type:      a.type || null,
    roleLabel: ROLE_LABELS[a.type] || a.type || null,
    personName: a.info?.person?.name || null,
    orgName:    a.info?.org?.name || null,
    name:       a.info?.person?.name || a.info?.org?.name || null,
    phone:      a.info?.contact?.phone || null,
    email:      a.info?.contact?.email || null,
  }));

  // Build actor lookup by id for timeline
  const actorById = {};
  for (const a of actors) { if (a.id) actorById[a.id] = a; }

  // ── Complainant ───────────────────────────────────────────────────────────
  let complainant = null;
  if (isV2) {
    const complainantId = issue.complainant_id || issue.source_id;
    const actor = complainantId
      ? actors.find(a => a.id === complainantId)
      : actors.find(a => a.type === 'CONSUMER' || a.type === 'INTERFACING_NP');
    if (actor) {
      complainant = { ...actor };
    }
  } else {
    complainant = {
      id: null, type: 'CONSUMER', roleLabel: 'Consumer',
      personName: issue.complainant_info?.person?.name || null,
      orgName: null,
      name:  issue.complainant_info?.person?.name || null,
      phone: issue.complainant_info?.contact?.phone || null,
      email: issue.complainant_info?.contact?.email || null,
    };
  }

  // ── Respondent ──────────────────────────────────────────────────────────
  let respondent = null;
  if (isV2) {
    const rActor = actors.find(a => a.type === 'COUNTERPARTY_NP');
    if (rActor) respondent = { ...rActor };
  }

  // ── GRO ─────────────────────────────────────────────────────────────────
  const gro = actors.find(a =>
    a.type === 'COUNTERPARTY_NP_GRO' || a.type === 'INTERFACING_NP_GRO') || null;

  // ── Actions timeline ──────────────────────────────────────────────────────
  let actions = [];
  if (isV2) {
    // Sort a copy chronologically without mutating original
    const sorted = [...(issue.actions || [])].sort((a, b) => {
      if (!a.updated_at || !b.updated_at) return 0;
      return new Date(a.updated_at) - new Date(b.updated_at);
    });
    actions = sorted.map((a, idx) => {
      const actorInfo = a.action_by ? actorById[a.action_by] : null;
      const ts = a.updated_at ? new Date(a.updated_at).getTime() : null;
      const prevTs = idx > 0 && sorted[idx - 1].updated_at
        ? new Date(sorted[idx - 1].updated_at).getTime() : null;
      const elapsedMs = ts && prevTs ? ts - prevTs : null;

      // Extract additional_info if present
      let additionalInfo = null;
      if (a.additional_info) additionalInfo = a.additional_info;

      // Extract attachment URLs (validate protocol)
      const attachments = [];
      if (Array.isArray(a.descriptor?.media)) {
        for (const m of a.descriptor.media) {
          const url = m.url || m.uri;
          if (url && /^https?:\/\//i.test(url)) {
            attachments.push({ url, mimetype: m.mimetype || null });
          }
        }
      }

      return {
        id:           a.id,
        code:         a.descriptor?.code || null,
        short_desc:   a.descriptor?.short_desc || a.descriptor?.code || null,
        updated_at:   a.updated_at || null,
        action_by:    a.action_by || null,
        actorName:    actorInfo?.name || null,
        actorRole:    actorInfo?.roleLabel || null,
        ref_id:       a.ref_id || null,
        ref_type:     a.ref_type || null,
        elapsedMs,
        additionalInfo,
        attachments: attachments.length ? attachments : null,
      };
    });
  } else {
    const ia = issue.issue_actions || {};
    for (const ca of (ia.complainant_actions || [])) {
      actions.push({
        id: null, code: ca.complainant_action, short_desc: ca.short_desc,
        updated_at: ca.updated_at?.odr?.updated_at || ca.updated_at || null,
        action_by: 'COMPLAINANT', actorName: complainant?.name, actorRole: 'Consumer',
        ref_id: null, ref_type: null, elapsedMs: null, additionalInfo: null, attachments: null,
      });
    }
    for (const ra of (ia.respondent_actions || [])) {
      actions.push({
        id: null, code: ra.respondent_action, short_desc: ra.short_desc,
        updated_at: ra.updated_at?.odr?.updated_at || ra.updated_at || null,
        action_by: 'RESPONDENT', actorName: 'Support Desk', actorRole: 'Respondent',
        ref_id: null, ref_type: null, elapsedMs: null, additionalInfo: null, attachments: null,
      });
    }
    // Sort chronologically (copy already)
    actions.sort((a, b) => {
      if (!a.updated_at || !b.updated_at) return 0;
      return new Date(a.updated_at) - new Date(b.updated_at);
    });
    // Compute elapsed for sorted v1 actions
    for (let i = 1; i < actions.length; i++) {
      const ts = actions[i].updated_at ? new Date(actions[i].updated_at).getTime() : null;
      const prevTs = actions[i-1].updated_at ? new Date(actions[i-1].updated_at).getTime() : null;
      if (ts && prevTs) actions[i].elapsedMs = ts - prevTs;
    }
  }

  // ── Resolutions ───────────────────────────────────────────────────────────
  const resolutions = (issue.resolutions || []).map(r => ({
    id:         r.id,
    code:       r.descriptor?.code || null,
    short_desc: r.descriptor?.short_desc || null,
    ref_id:     r.ref_id || null,
    ref_type:   r.ref_type || null,
    proposed_by: r.proposed_by || null,
    tags:       r.tags || [],
  }));

  // ── Final resolution determination ──────────────────────────────────────
  // 1. Find RESOLUTION_ACCEPTED action → its ref_id points to accepted resolution
  // 2. Find RESOLVED action → its ref_id may point to final outcome
  // 3. If RESOLUTION_ACCEPTED.ref_id doesn't match any resolution, flag mismatch
  const acceptedAction = actions.find(a => a.code === 'RESOLUTION_ACCEPTED');
  const resolvedAction = actions.find(a => a.code === 'RESOLVED');

  let acceptedResolution = null;
  let resolvedResolution = null;
  let resolutionWarning  = null;

  if (acceptedAction?.ref_id && resolutions.length) {
    acceptedResolution = resolutions.find(r => r.id === acceptedAction.ref_id) || null;
    if (!acceptedResolution) {
      // ref_id doesn't match any resolution — flag but don't block
      resolutionWarning = `RESOLUTION_ACCEPTED references "${acceptedAction.ref_id}" which does not match any resolution ID in this payload`;
    }
  }

  if (resolvedAction?.ref_id && resolutions.length) {
    resolvedResolution = resolutions.find(r => r.id === resolvedAction.ref_id) || null;
  }

  // Final resolution = resolved action's ref takes precedence, then accepted action's ref
  let finalResolution = resolvedResolution || acceptedResolution || null;

  // Fallback: if only one non-PARENT resolution, that's the one
  if (!finalResolution && resolutions.length) {
    const nonParent = resolutions.filter(r => r.code !== 'PARENT');
    if (nonParent.length === 1) finalResolution = nonParent[0];
  }

  // ── Timestamps ────────────────────────────────────────────────────────────
  const createdAt  = issue.created_at || ctx.timestamp || null;
  const resolvedAt = resolvedAction?.updated_at || null;
  const closedAction = actions.find(a => a.code === 'CLOSED');
  const closedAt   = closedAction?.updated_at || null;

  // ── Status ────────────────────────────────────────────────────────────────
  const status = issue.status || null;

  // ── Closure feedback (CLOSURE_DETAILS rating from actions or tags) ──────
  let closureFeedback = null;
  const closedActRaw = (issue.actions || []).find(a =>
    a.descriptor?.code === 'CLOSED');
  if (closedActRaw) {
    const closureTags = (closedActRaw.tags || []).find(t =>
      t.descriptor?.code === 'CLOSURE_DETAILS');
    if (closureTags) {
      const rating = closureTags.list?.find(l =>
        l.descriptor?.code === 'RATING')?.value || null;
      const remarks = closureTags.list?.find(l =>
        l.descriptor?.code === 'REMARKS')?.value || null;
      closureFeedback = {
        rating, remarks,
        closedBy: closedActRaw.action_by || null,
        closedByName: (closedActRaw.action_by && actorById[closedActRaw.action_by]?.name) || null,
        closedAt: closedActRaw.updated_at || null,
      };
    }
    if (!closureFeedback && issue.closure_reason) {
      closureFeedback = {
        rating: issue.closure_reason.code || null,
        remarks: issue.closure_reason.short_desc || null,
        closedBy: closedActRaw.action_by || null,
        closedByName: null,
        closedAt: closedActRaw.updated_at || null,
      };
    }
  }

  // ── Refund details from REFUND resolution tags (regardless of acceptance) ──
  let refundDetails = null;
  const refundRes = resolutions.find(r => r.code === 'REFUND');
  if (refundRes?.tags?.length) {
    const detailTag = refundRes.tags.find(t =>
      t.descriptor?.code === 'RESOLUTION_DETAILS');
    if (detailTag) {
      refundDetails = {
        item:   detailTag.list?.find(l => l.descriptor?.code === 'ITEM')?.value || null,
        amount: detailTag.list?.find(l => l.descriptor?.code === 'REFUND_AMOUNT')?.value || null,
        isAccepted: finalResolution?.code === 'REFUND',
      };
    }
  }

  return {
    issueId:       issue.id || null,
    transactionId: ctx.transaction_id || null,
    orderId,
    providerId,
    fulfillmentId,
    itemId,
    descriptorCode,
    shortDesc,
    longDesc,
    images,
    category,
    subCategory,
    issueType,
    complainant,
    respondent,
    gro,
    actors,
    actions,
    resolutions,
    acceptedResolution,
    resolvedResolution,
    finalResolution,
    resolutionWarning,
    refundDetails,
    closureFeedback,
    status,
    createdAt,
    resolvedAt,
    closedAt,
    isV2,
  };
}

module.exports = { parseIgm2Issue };
