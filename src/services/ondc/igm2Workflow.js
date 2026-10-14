const { randomUUID } = require('crypto');

// IGM 2.0 state machine. Each issue is serialized so deferred events cannot
// race with incoming requests. Retries up to 3 times on transient failures.
const createIgm2Workflow = ({ send, persist, onClose, getRefundAmount, schedule = setTimeout, log = () => {} }) => {
  const sessions = new Map();
  const locks = new Map();
  const keyFor = (context, tenant, issueId) => JSON.stringify([tenant.id, context.transaction_id, issueId]);

  const serialize = (key, work) => {
    const previous = locks.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      const current = sessions.get(key);
      const snapshot = current && structuredClone(current);
      try { return await work(); } catch (error) {
        if (snapshot) Object.assign(current, snapshot);
        else sessions.delete(key);
        throw error;
      }
    });
    locks.set(key, result);
    result.finally(() => { if (locks.get(key) === result) locks.delete(key); }).catch(() => {});
    return result;
  };

  const merge = (...groups) => [...new Map(groups.flat().filter(a => a?.id).map(a => [a.id, a])).values()];

  const makeAction = (s, code, refId) => ({
    id: randomUUID(),
    descriptor: { code, short_desc: code.replace(/_/g, ' ') },
    updated_at: new Date().toISOString(),
    action_by: s.respondentId,
    actor_details: { name: 'Support Desk' },
    ...(refId ? { ref_id: refId,
      ...(['RESOLUTION_PROPOSED', 'RESOLVED'].includes(code) ? { ref_type: 'RESOLUTIONS' } : {}) } : {}),
  });

  // Build on_issue message body with optional extra fields on the issue object
  const message = (s, extra = {}) => ({
    update_target: [{ path: 'issue.actions', action: 'APPENDED' }],
    issue: {
      ...s.issue,
      actors: merge(s.issue.actors || [], [s.respondentActor]),
      actions: s.actions,
      ...(s.resolutions.length ? { resolutions: s.resolutions } : {}),
      status: s.status,
      respondent_ids: [s.respondentId],
      resolver_ids: [s.respondentId],
      last_action_id: s.actions.at(-1)?.id,
      updated_at: new Date().toISOString(),
      ...extra,
    },
  });

  const emit = async (s, context, unsolicited = false, api = 'on_issue', extra = {}) => {
    const response = await send(context.bap_uri, api,
      { ...context, message_id: unsolicited ? randomUUID() : context.message_id },
      message(s, extra), s.tenant);
    if (response?.message?.ack?.status !== 'ACK') throw new Error(`IGM ${api} was not acknowledged`);
  };

  const defer = (key, s, expected, work, attempt = 1) => {
    const revision = s.revision;
    schedule(() => serialize(key, async () => {
      if (s.revision !== revision || s.state !== expected) return;
      await work();
    }).catch(e => {
      log(e.message);
      if (attempt < 3 && s.revision === revision && s.state === expected) defer(key, s, expected, work, attempt + 1);
    }), 2000);
  };

  // Determine resolution action based on profile and escalation state
  const resolveAction = s => s.escalated ? 'REFUND' : 'NO-ACTION';

  // Send NEED-MORE-INFO with additional_info_required
  const sendNeedMoreInfo = async (s, desc) => {
    s.actions.push(makeAction(s, 'NEED-MORE-INFO'));
    await emit(s, s.context, true, 'on_issue', {
      additional_info_required: [{
        info_required: {
          issue_update_info: {
            code: 'REASON',
            name: 'Additional information required',
            short_desc: desc || 'Please share additional details about the issue',
          },
          message_id: randomUUID(),
          updated_at: new Date().toISOString(),
        },
      }],
    });
    s.state = 'AWAITING_INFO';
  };

  // Send RESOLVED with resolution details
  const sendResolved = async (s, context, unsolicited = false) => {
    const act = resolveAction(s);
    let refundAmount = '0.00';
    if (act === 'REFUND' && getRefundAmount) {
      try { refundAmount = String(getRefundAmount(s)); } catch (_) { /* use default */ }
    }
    s.actions.push(makeAction(s, 'RESOLVED'));
    s.status = 'RESOLVED';
    s.selected = { descriptor: { code: act === 'NO-ACTION' ? 'NO_ACTION' : act } };
    await emit(s, context, unsolicited, 'on_issue', {
      resolution: {
        network_issue_id: s.issue.id,
        short_desc: `Issue resolved — ${act.toLowerCase().replace(/_/g, ' ')}`,
        long_desc: `Issue resolved — ${act.toLowerCase().replace(/_/g, ' ')}`,
        resolution_remarks: `Issue resolved — ${act.toLowerCase().replace(/_/g, ' ')}`,
        resolution_action: 'RESOLVE',
        action_triggered: act,
        refund_amount: refundAmount,
      },
    });
    s.state = 'AWAITING_DECISION';
    await persist(s, 'in_progress');
  };

  const handle = (issue, context, tenant, profile = 'igm') => {
    const key = keyFor(context, tenant, issue.id);
    return serialize(key, async () => {
      let s = sessions.get(key);
      const actions = Array.isArray(issue.actions) ? issue.actions : [];
      const incoming = actions.find(a => a.id === issue.last_action_id) || actions.at(-1);
      const code = incoming?.descriptor?.code;
      const eventId = incoming?.id || context.message_id;
      if (s?.processed.has(eventId)) return;

      if (!s) {
        if (issue.status !== 'OPEN' || code !== 'OPEN') throw new Error('Unknown IGM issue must start with OPEN');
        const respondent = issue.actors?.find(a => a.type === 'COUNTERPARTY_NP');
        const respondentId = respondent?.id || issue.respondent_ids?.[0] || tenant.subscriber_id;
        s = {
          tenant, context, issue: structuredClone(issue), profile,
          respondentId,
          respondentActor: respondent || {
            id: respondentId, type: 'COUNTERPARTY_NP',
            info: {
              org: { name: `${tenant.subscriber_id}::${context.domain || 'ONDC:RET10'}` },
              person: { name: 'Support Desk' },
              contact: {
                phone: process.env.SUPPORT_PHONE || '9059304940',
                email: process.env.SUPPORT_EMAIL || 'support@cottkart.com',
              },
            },
          },
          actions: [], resolutions: [], processed: new Set(), revision: 0, state: 'NEW',
        };
        sessions.set(key, s);
      }
      if (s.state === 'CLOSED') return;
      s.context = structuredClone(context);
      s.issue = { ...s.issue, ...structuredClone(issue),
        created_at: s.issue.created_at || issue.created_at || new Date().toISOString() };
      s.actions = merge(s.actions, actions);
      s.revision++;

      // ── OPEN: send PROCESSING, then defer NEED-MORE-INFO ──────────────────
      if (s.state === 'NEW') {
        s.actions.push(makeAction(s, 'PROCESSING'));
        s.status = 'PROCESSING';
        await emit(s, context);
        s.state = 'PROCESSING';
        await persist(s, 'in_progress');
        defer(key, s, 'PROCESSING', () =>
          sendNeedMoreInfo(s, 'Please share additional details about the issue'));

      // ── INFO_PROVIDED: send RESOLVED with resolution ──────────────────────
      } else if (code === 'INFO_PROVIDED' && s.state === 'AWAITING_INFO') {
        await sendResolved(s, context, false);

      // ── RESOLUTION_REJECTED: re-process, then defer NEED-MORE-INFO ────────
      } else if (code === 'RESOLUTION_REJECTED' && s.state === 'AWAITING_DECISION') {
        s.escalated = false; // rejection resets to re-evaluation
        s.actions.push(makeAction(s, 'PROCESSING', incoming.ref_id));
        s.status = 'PROCESSING';
        await emit(s, context);
        s.state = 'PROCESSING';
        defer(key, s, 'PROCESSING', () =>
          sendNeedMoreInfo(s, 'Please share additional details to help process your refund'));

      // ── ESCALATED: mark escalated, send PROCESSING, defer RESOLVED + NEED-MORE-INFO
      } else if (code === 'ESCALATED' && ['AWAITING_DECISION', 'PROCESSING'].includes(s.state)) {
        s.escalated = true;
        s.actions.push(makeAction(s, 'PROCESSING', incoming.id));
        s.status = 'PROCESSING';
        await emit(s, context);
        s.state = 'PROCESSING';
        defer(key, s, 'PROCESSING', async () => {
          await sendResolved(s, s.context, true);
          // After RESOLVED, defer NEED-MORE-INFO asking for confirmation
          defer(key, s, 'AWAITING_DECISION', async () => {
            // Transition back to AWAITING_INFO so next INFO_PROVIDED/RESOLUTION_ACCEPTED is accepted
            s.actions.push(makeAction(s, 'NEED-MORE-INFO'));
            await emit(s, s.context, true, 'on_issue', {
              additional_info_required: [{
                info_required: {
                  issue_update_info: {
                    code: 'REASON',
                    name: 'Resolution confirmation required',
                    short_desc: 'Please confirm acceptance of the refund resolution',
                  },
                  message_id: randomUUID(),
                  updated_at: new Date().toISOString(),
                },
              }],
            });
            // Stay in AWAITING_DECISION — BAP will send RESOLUTION_ACCEPTED next
          });
        });

      // ── RESOLUTION_ACCEPTED: send RESOLVED (final confirmation) ───────────
      } else if (code === 'RESOLUTION_ACCEPTED' && s.state === 'AWAITING_DECISION') {
        s.actions.push(makeAction(s, 'RESOLVED'));
        s.status = 'RESOLVED';
        // Ensure selected is set for onClose
        if (!s.selected) s.selected = { descriptor: { code: resolveAction(s) === 'NO-ACTION' ? 'NO_ACTION' : resolveAction(s) } };
        await emit(s, context);
        s.state = 'AWAITING_CLOSE';
        await persist(s, 'resolved');

      // ── CLOSED: trigger onClose (sends on_status or on_update) ────────────
      } else if (issue.status === 'CLOSED' && code === 'CLOSED' && s.state === 'AWAITING_CLOSE') {
        await onClose(s, context);
        s.status = 'CLOSED';
        s.state = 'CLOSED';
        await persist(s, 'closed');

      } else {
        s.revision--;
        throw new Error(`Unexpected IGM action ${code} in ${s.state}`);
      }
      s.processed.add(eventId);
    });
  };

  const get = (context, tenant, issueId) => sessions.get(keyFor(context, tenant, issueId));
  const status = async (context, tenant, issueId) => {
    const key = keyFor(context, tenant, issueId);
    return serialize(key, async () => {
      const s = sessions.get(key);
      if (s) await emit(s, context, false, 'on_issue_status');
      return Boolean(s);
    });
  };
  return { handle, get, status };
};
module.exports = { createIgm2Workflow };
