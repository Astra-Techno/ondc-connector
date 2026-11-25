const assert = require('assert');
const { parseIgm2Issue } = require('../src/services/ondc/parseIgm2Issue');

// ── Test 1: Full IGM 2.0 CLOSED payload (9 actions, like issue f948e07a) ──
const igm2ClosedPayload = {
  context: { transaction_id: 'd27d0333-c0a1-4144-9947-38cdbd843207', timestamp: '2026-10-20T10:00:00Z' },
  message: {
    issue: {
      id: 'f948e07a-4502-46c2-b5d0-1d94b3efbeee',
      status: 'CLOSED',
      descriptor: { code: 'ORD02', short_desc: 'Unsatisfactory order', long_desc: 'Quality issues with delivered items' },
      category: 'ORDER',
      complainant_id: 'buyer-app.ondc.org',
      source_id: 'buyer-app.ondc.org',
      refs: [
        { ref_type: 'ORDER', ref_id: '426143' },
        { ref_type: 'PROVIDER', ref_id: 'V001' },
        { ref_type: 'FULFILLMENT', ref_id: 'f1' },
        { ref_type: 'ITEM', ref_id: 'P001' },
      ],
      actors: [
        { id: 'buyer-app.ondc.org', type: 'INTERFACING_NP', info: { person: { name: 'John Doe' }, contact: { phone: '9876543210', email: 'john@example.com' } } },
        { id: 'seller-app.ondc.org', type: 'COUNTERPARTY_NP', info: { person: { name: 'Support Desk' }, contact: { phone: '1234567890', email: 'support@seller.com' } } },
      ],
      actions: [
        { id: 'a1', descriptor: { code: 'OPEN', short_desc: 'Issue opened' }, updated_at: '2026-10-20T10:00:00Z', action_by: 'buyer-app.ondc.org' },
        { id: 'a2', descriptor: { code: 'PROCESSING' }, updated_at: '2026-10-20T10:00:01Z', action_by: 'seller-app.ondc.org' },
        { id: 'a3', descriptor: { code: 'NEED-MORE-INFO' }, updated_at: '2026-10-20T10:00:03Z', action_by: 'seller-app.ondc.org' },
        { id: 'a4', descriptor: { code: 'INFO_PROVIDED' }, updated_at: '2026-10-20T10:00:05Z', action_by: 'buyer-app.ondc.org' },
        { id: 'a5', descriptor: { code: 'PROCESSING' }, updated_at: '2026-10-20T10:00:06Z', action_by: 'seller-app.ondc.org' },
        { id: 'a6', descriptor: { code: 'RESOLUTION_PROPOSED' }, updated_at: '2026-10-20T10:00:08Z', action_by: 'seller-app.ondc.org', ref_id: 'R_PARENT' },
        { id: 'a7', descriptor: { code: 'RESOLUTION_ACCEPTED' }, updated_at: '2026-10-20T10:00:10Z', action_by: 'buyer-app.ondc.org', ref_id: 'R_NO_ACTION' },
        { id: 'a8', descriptor: { code: 'RESOLVED' }, updated_at: '2026-10-20T10:00:12Z', action_by: 'seller-app.ondc.org', ref_id: 'R_NO_ACTION' },
        { id: 'a9', descriptor: { code: 'CLOSED' }, updated_at: '2026-10-20T10:00:15Z', action_by: 'buyer-app.ondc.org' },
      ],
      resolutions: [
        { id: 'R_PARENT', descriptor: { code: 'PARENT', short_desc: 'Resolution options' }, proposed_by: 'seller-app.ondc.org' },
        { id: 'R_NO_ACTION', ref_id: 'R_PARENT', ref_type: 'PARENT', descriptor: { code: 'NO-ACTION', short_desc: 'No action required' }, proposed_by: 'seller-app.ondc.org' },
        { id: 'R_REFUND', ref_id: 'R_PARENT', ref_type: 'PARENT', descriptor: { code: 'REFUND', short_desc: 'Refund' }, proposed_by: 'seller-app.ondc.org', tags: [{ descriptor: { code: 'RESOLUTION_DETAILS' }, list: [{ descriptor: { code: 'ITEM' }, value: 'P001' }, { descriptor: { code: 'REFUND_AMOUNT' }, value: '100.00' }] }] },
      ],
      created_at: '2026-10-20T10:00:00Z',
    },
  },
};

function test1_fullIgm2Closed() {
  const r = parseIgm2Issue(igm2ClosedPayload);
  assert.strictEqual(r.issueId, 'f948e07a-4502-46c2-b5d0-1d94b3efbeee', 'issue ID');
  assert.strictEqual(r.transactionId, 'd27d0333-c0a1-4144-9947-38cdbd843207', 'transaction ID');
  assert.strictEqual(r.orderId, '426143', 'order ref');
  assert.strictEqual(r.providerId, 'V001', 'provider ref');
  assert.strictEqual(r.fulfillmentId, 'f1', 'fulfillment ref');
  assert.strictEqual(r.itemId, 'P001', 'item ref');
  assert.strictEqual(r.descriptorCode, 'ORD02', 'descriptor code');
  assert.strictEqual(r.shortDesc, 'Unsatisfactory order', 'short desc');
  assert.strictEqual(r.status, 'CLOSED', 'status');
  assert.strictEqual(r.isV2, true, 'isV2');

  // Complainant
  assert.strictEqual(r.complainant.name, 'John Doe');
  assert.strictEqual(r.complainant.phone, '9876543210');
  assert.strictEqual(r.complainant.type, 'INTERFACING_NP');

  // Actions
  assert.strictEqual(r.actions.length, 9, '9 actions');
  assert.strictEqual(r.actions[0].code, 'OPEN');
  assert.strictEqual(r.actions[8].code, 'CLOSED');

  // Resolutions
  assert.strictEqual(r.resolutions.length, 3, '3 resolutions (PARENT + 2 options)');

  // Accepted resolution — should be NO-ACTION (ref_id R_NO_ACTION in RESOLUTION_ACCEPTED action)
  assert.ok(r.acceptedResolution, 'has accepted resolution');
  assert.strictEqual(r.acceptedResolution.code, 'NO-ACTION', 'accepted = NO-ACTION, NOT REFUND');
  assert.notStrictEqual(r.acceptedResolution.code, 'REFUND', 'must not confuse proposed REFUND with accepted');

  // Timestamps
  assert.strictEqual(r.resolvedAt, '2026-10-20T10:00:12Z', 'resolved timestamp');
  assert.strictEqual(r.closedAt, '2026-10-20T10:00:15Z', 'closed timestamp');

  console.log('  PASS: test1_fullIgm2Closed');
}

// ── Test 2: Missing fields — no actors, no refs, no resolutions ──
function test2_missingFields() {
  const r = parseIgm2Issue({
    context: { transaction_id: 'txn-1' },
    message: { issue: { id: 'issue-1', status: 'OPEN', actions: [{ id: 'a1', descriptor: { code: 'OPEN' } }] } },
  });
  assert.strictEqual(r.issueId, 'issue-1');
  assert.strictEqual(r.orderId, null, 'no order ref');
  assert.strictEqual(r.complainant, null, 'no complainant');
  assert.strictEqual(r.acceptedResolution, null, 'no resolution');
  assert.strictEqual(r.resolvedAt, null);
  assert.strictEqual(r.closedAt, null);
  assert.strictEqual(r.actions.length, 1);
  console.log('  PASS: test2_missingFields');
}

// ── Test 3: IGM 1.0 compatibility ──
function test3_igm10() {
  const r = parseIgm2Issue({
    context: { transaction_id: 'txn-10' },
    message: {
      issue: {
        id: 'issue-10', status: 'RESOLVED',
        order_details: { id: 'order-100' },
        complainant_info: { person: { name: 'Alice' }, contact: { phone: '555-0001', email: 'alice@test.com' } },
        issue_actions: {
          complainant_actions: [
            { complainant_action: 'OPEN', updated_at: '2026-01-01T00:00:00Z' },
          ],
          respondent_actions: [
            { respondent_action: 'PROCESSING', updated_at: '2026-01-01T00:00:01Z' },
            { respondent_action: 'RESOLVED', updated_at: '2026-01-01T00:00:05Z' },
          ],
        },
      },
    },
  });
  assert.strictEqual(r.isV2, false, 'IGM 1.0');
  assert.strictEqual(r.orderId, 'order-100', 'order from order_details');
  assert.strictEqual(r.complainant.name, 'Alice');
  assert.strictEqual(r.actions.length, 3, '3 actions total');
  // Sorted chronologically
  assert.strictEqual(r.actions[0].code, 'OPEN');
  assert.strictEqual(r.actions[2].code, 'RESOLVED');
  console.log('  PASS: test3_igm10');
}

// ── Test 4: Duplicate message/action IDs ──
function test4_duplicateActions() {
  const r = parseIgm2Issue({
    context: {},
    message: {
      issue: {
        id: 'dup-1', status: 'PROCESSING', actions: [
          { id: 'a1', descriptor: { code: 'OPEN' }, updated_at: '2026-01-01T00:00:00Z' },
          { id: 'a1', descriptor: { code: 'OPEN' }, updated_at: '2026-01-01T00:00:00Z' }, // duplicate
          { id: 'a2', descriptor: { code: 'PROCESSING' }, updated_at: '2026-01-01T00:00:01Z' },
        ],
      },
    },
  });
  // parseIgm2Issue maps all actions as-is (dedup is in igm2Workflow via processed set)
  // but it should not crash on duplicates
  assert.ok(r.actions.length >= 2, 'handles duplicates without crash');
  console.log('  PASS: test4_duplicateActions');
}

// ── Test 5: Null/undefined input ──
function test5_nullInput() {
  const r1 = parseIgm2Issue(null);
  assert.strictEqual(r1.issueId, null);
  assert.deepStrictEqual(r1.actions, []);

  const r2 = parseIgm2Issue({});
  assert.strictEqual(r2.issueId, null);

  const r3 = parseIgm2Issue({ message: {} });
  assert.strictEqual(r3.issueId, null);

  console.log('  PASS: test5_nullInput');
}

// ── Test 6: NO-ACTION vs REFUND distinction ──
function test6_resolutionDistinction() {
  // BAP accepted NO-ACTION, even though REFUND was also proposed
  const r = parseIgm2Issue(igm2ClosedPayload);
  assert.strictEqual(r.acceptedResolution.code, 'NO-ACTION',
    'Must distinguish between proposed REFUND option and actually accepted NO-ACTION');

  // Now test with REFUND accepted
  const refundPayload = JSON.parse(JSON.stringify(igm2ClosedPayload));
  refundPayload.message.issue.actions[6].ref_id = 'R_REFUND'; // RESOLUTION_ACCEPTED points to REFUND
  const r2 = parseIgm2Issue(refundPayload);
  assert.strictEqual(r2.acceptedResolution.code, 'REFUND',
    'When BAP accepts REFUND, accepted resolution should be REFUND');

  console.log('  PASS: test6_resolutionDistinction');
}

// ── Run all ──
console.log('parseIgm2Issue tests:');
test1_fullIgm2Closed();
test2_missingFields();
test3_igm10();
test4_duplicateActions();
test5_nullInput();
test6_resolutionDistinction();
console.log('\nAll tests passed!');
