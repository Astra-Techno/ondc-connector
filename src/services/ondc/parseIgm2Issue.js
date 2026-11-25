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
    // IGM 1.0 fallback
    if (type === 'ORDER') return issue.order_details?.id || issue.order_id || null;
    return null;
  };

  const orderId     = refOf('ORDER');
  const providerId  = refOf('PROVIDER');
  const fulfillmentId = refOf('FULFILLMENT');
  const itemId      = refOf('ITEM');

  // ── Descriptor ────────────────────────────────────────────────────────────
  const descriptorCode = issue.descriptor?.code || null;
  const shortDesc      = issue.descriptor?.short_desc || issue.description || null;
  const longDesc       = issue.descriptor?.long_desc || null;
  const images         = Array.isArray(issue.descriptor?.images) ? issue.descriptor.images : [];

  // ── Category / type ───────────────────────────────────────────────────────
  const category    = issue.category || descriptorCode || null;
  const subCategory = issue.sub_category || null;
  const issueType   = issue.issue_type || 'ISSUE';

  // ── Complainant ───────────────────────────────────────────────────────────
  let complainant = null;
  if (isV2) {
    const complainantId = issue.complainant_id || issue.source_id;
    const actor = complainantId
      ? (issue.actors || []).find(a => a.id === complainantId)
      : (issue.actors || []).find(a => a.type === 'CONSUMER' || a.type === 'INTERFACING_NP');
    if (actor) {
      complainant = {
        name:  actor.info?.person?.name || null,
        phone: actor.info?.contact?.phone || null,
        email: actor.info?.contact?.email || null,
        type:  actor.type || null,
        id:    actor.id || complainantId || null,
      };
    }
  } else {
    // IGM 1.0
    complainant = {
      name:  issue.complainant_info?.person?.name || null,
      phone: issue.complainant_info?.contact?.phone || null,
      email: issue.complainant_info?.contact?.email || null,
      type:  'CONSUMER',
      id:    null,
    };
  }

  // ── Actions timeline ──────────────────────────────────────────────────────
  let actions = [];
  if (isV2) {
    actions = (issue.actions || []).map(a => ({
      id:          a.id,
      code:        a.descriptor?.code || null,
      short_desc:  a.descriptor?.short_desc || a.descriptor?.code || null,
      updated_at:  a.updated_at || null,
      action_by:   a.action_by || null,
      ref_id:      a.ref_id || null,
      ref_type:    a.ref_type || null,
    }));
  } else {
    // IGM 1.0: flatten complainant_actions + respondent_actions
    const ia = issue.issue_actions || {};
    for (const ca of (ia.complainant_actions || [])) {
      actions.push({
        id: null, code: ca.complainant_action, short_desc: ca.short_desc,
        updated_at: ca.updated_at?.odr?.updated_at || ca.updated_at || null,
        action_by: 'COMPLAINANT', ref_id: null, ref_type: null,
      });
    }
    for (const ra of (ia.respondent_actions || [])) {
      actions.push({
        id: null, code: ra.respondent_action, short_desc: ra.short_desc,
        updated_at: ra.updated_at?.odr?.updated_at || ra.updated_at || null,
        action_by: 'RESPONDENT', ref_id: null, ref_type: null,
      });
    }
    // Sort chronologically
    actions.sort((a, b) => {
      if (!a.updated_at || !b.updated_at) return 0;
      return new Date(a.updated_at) - new Date(b.updated_at);
    });
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

  // ── Accepted resolution ───────────────────────────────────────────────────
  // Find the RESOLUTION_ACCEPTED action → its ref_id points to the accepted resolution
  const acceptedAction = actions.find(a => a.code === 'RESOLUTION_ACCEPTED');
  let acceptedResolution = null;
  if (acceptedAction?.ref_id && resolutions.length) {
    acceptedResolution = resolutions.find(r => r.id === acceptedAction.ref_id) || null;
  }
  // Fallback: if only one non-PARENT resolution, that's the one
  if (!acceptedResolution && resolutions.length) {
    const nonParent = resolutions.filter(r => r.code !== 'PARENT');
    if (nonParent.length === 1) acceptedResolution = nonParent[0];
  }

  // ── Timestamps ────────────────────────────────────────────────────────────
  const createdAt  = issue.created_at || ctx.timestamp || null;
  const resolvedAction = actions.find(a => a.code === 'RESOLVED');
  const closedAction   = actions.find(a => a.code === 'CLOSED');
  const resolvedAt = resolvedAction?.updated_at || null;
  const closedAt   = closedAction?.updated_at || null;

  // ── Status ────────────────────────────────────────────────────────────────
  const status = issue.status || null;

  // ── Actors (all) ────────────────────────────────────────────────────────
  const actors = (issue.actors || []).map(a => ({
    id:    a.id || null,
    type:  a.type || null,
    name:  a.info?.person?.name || a.info?.org?.name || null,
    phone: a.info?.contact?.phone || null,
    email: a.info?.contact?.email || null,
  }));

  // ── Respondent ──────────────────────────────────────────────────────────
  let respondent = null;
  if (isV2) {
    const rActor = (issue.actors || []).find(a => a.type === 'COUNTERPARTY_NP');
    if (rActor) {
      respondent = {
        name:  rActor.info?.person?.name || rActor.info?.org?.name || null,
        phone: rActor.info?.contact?.phone || null,
        email: rActor.info?.contact?.email || null,
        type:  rActor.type,
        id:    rActor.id || null,
      };
    }
  }

  // ── Closure feedback (CLOSURE_DETAILS rating from actions or tags) ──────
  let closureFeedback = null;
  const closedAct = (issue.actions || []).find(a =>
    a.descriptor?.code === 'CLOSED');
  if (closedAct) {
    // Check tags on the CLOSED action
    const closureTags = (closedAct.tags || []).find(t =>
      t.descriptor?.code === 'CLOSURE_DETAILS');
    if (closureTags) {
      const rating = closureTags.list?.find(l =>
        l.descriptor?.code === 'RATING')?.value || null;
      const remarks = closureTags.list?.find(l =>
        l.descriptor?.code === 'REMARKS')?.value || null;
      closureFeedback = { rating, remarks };
    }
    // Also check closure_reason on the issue itself
    if (!closureFeedback && issue.closure_reason) {
      closureFeedback = { rating: issue.closure_reason.code || null, remarks: issue.closure_reason.short_desc || null };
    }
  }

  // ── Refund details from accepted resolution tags ────────────────────────
  let refundDetails = null;
  if (acceptedResolution?.code === 'REFUND' && acceptedResolution.tags?.length) {
    const detailTag = acceptedResolution.tags.find(t =>
      t.descriptor?.code === 'RESOLUTION_DETAILS');
    if (detailTag) {
      refundDetails = {
        item:   detailTag.list?.find(l => l.descriptor?.code === 'ITEM')?.value || null,
        amount: detailTag.list?.find(l => l.descriptor?.code === 'REFUND_AMOUNT')?.value || null,
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
    actors,
    actions,
    resolutions,
    acceptedResolution,
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
