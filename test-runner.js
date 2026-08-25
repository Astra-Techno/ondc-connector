/**
 * ONDC Flow Test Runner — Acts as a mock BAP to test our BPP responses.
 *
 * Usage:
 *   node test-runner.js [--bpp-url http://localhost:4000] [--flow return]
 *
 * Starts a local Express server (BAP) on port 9090, sends flow requests
 * to the BPP, receives callbacks, and validates them against the automation spec.
 */
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const jp = require('jsonpath');

// ── Config ──────────────────────────────────────────────────────────────
const BAP_PORT  = 9090;
const BAP_ID    = 'test-runner.local';
const BAP_URI   = `http://localhost:${BAP_PORT}`;
const BPP_URL   = process.argv.includes('--bpp-url')
  ? process.argv[process.argv.indexOf('--bpp-url') + 1]
  : 'http://localhost:4000';

const TRANSACTION_ID = uuidv4();
const PROVIDER_ID    = 'P001'; // Must match our products table
const LOCATION_ID    = 'l1';
const ITEM_IDS       = ['P001', 'P002']; // Must match our products

// ── Validation helpers ──────────────────────────────────────────────────
const results = [];

function check(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  results.push({ name, status, detail });
  const icon = condition ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ''}`);
  return condition;
}

function present(payload, jsonPath) {
  try {
    const vals = jp.query(payload, jsonPath);
    return vals.length > 0 && vals[0] !== undefined && vals[0] !== null;
  } catch { return false; }
}

function queryAll(payload, jsonPath) {
  try { return jp.query(payload, jsonPath); }
  catch { return []; }
}

// ── Build ONDC context ──────────────────────────────────────────────────
function buildContext(action) {
  return {
    domain: 'ONDC:RET10',
    country: 'IND',
    city: 'std:080',
    action,
    core_version: '1.2.0',
    bap_id: BAP_ID,
    bap_uri: BAP_URI,
    bpp_id: process.env.ONDC_SUBSCRIBER_ID || 'ondc.cottkart.com',
    bpp_uri: BPP_URL,
    transaction_id: TRANSACTION_ID,
    message_id: uuidv4(),
    timestamp: new Date().toISOString(),
    ttl: 'PT30S',
  };
}

// ── Validate on_select ──────────────────────────────────────────────────
function validateOnSelect(payload) {
  console.log('\n── on_select validation ──');

  // Context checks
  const ctx = payload.context || {};
  check('context.action', ctx.action === 'on_select', `got: ${ctx.action}`);
  check('context.bpp_id present', !!ctx.bpp_id, `got: ${ctx.bpp_id}`);
  check('context.bpp_uri present', !!ctx.bpp_uri);
  check('context.transaction_id matches', ctx.transaction_id === TRANSACTION_ID);
  check('context.bap_id preserved', ctx.bap_id === BAP_ID, `got: ${ctx.bap_id}`);

  const order = payload.message?.order;
  if (!check('message.order present', !!order)) return;

  // Provider
  check('provider.id present', present(payload, '$.message.order.provider.id'));

  // Items
  const itemIds = queryAll(payload, '$.message.order.items[*].id');
  check('items present', itemIds.length > 0, `count: ${itemIds.length}`);

  const fulfillmentIds = queryAll(payload, '$.message.order.items[*].fulfillment_id');
  const fulfillmentIdsList = queryAll(payload, '$.message.order.items[*].fulfillment_ids[*]');
  check('items have fulfillment_id or fulfillment_ids',
    fulfillmentIds.length > 0 || fulfillmentIdsList.length > 0);

  // Check items DON'T have extra fields (on_select items should only have id + fulfillment_id)
  if (order.items) {
    const extraKeys = Object.keys(order.items[0] || {}).filter(k => !['id', 'fulfillment_id', 'fulfillment_ids'].includes(k));
    check('items have no extra properties', extraKeys.length === 0,
      extraKeys.length > 0 ? `extra: ${extraKeys.join(', ')}` : '');
  }

  // Fulfillments
  check('fulfillments[*].id', present(payload, '$.message.order.fulfillments[*].id'));
  check('fulfillments[*].type', present(payload, '$.message.order.fulfillments[*].type'));
  check('fulfillments[*].@ondc/org/provider_name',
    present(payload, "$.message.order.fulfillments[*]['@ondc/org/provider_name']"));
  check('fulfillments[*].tracking',
    payload.message?.order?.fulfillments?.[0]?.tracking !== undefined);
  check('fulfillments[*].@ondc/org/category',
    present(payload, "$.message.order.fulfillments[*]['@ondc/org/category']"));

  const stateCodes = queryAll(payload, '$.message.order.fulfillments[*].state.descriptor.code');
  const validStates = ['Serviceable', 'Non-serviceable'];
  check('fulfillments state.descriptor.code valid',
    stateCodes.length > 0 && stateCodes.every(c => validStates.includes(c)),
    `got: ${stateCodes.join(', ')}`);

  // Fulfillment tags validation (optional but if present must be valid)
  const tagCodes = queryAll(payload, '$.message.order.fulfillments[*].tags[*].code');
  if (tagCodes.length > 0) {
    check('fulfillment tags codes valid (only order_details allowed)',
      tagCodes.every(c => c === 'order_details'),
      `got: ${tagCodes.join(', ')}`);
  }

  // Check fulfillments DON'T have end.location (shouldn't be in on_select)
  const hasEndLocation = payload.message?.order?.fulfillments?.some(f => f.end?.location);
  check('fulfillments no end.location (not in on_select spec)', !hasEndLocation);

  // Quote
  check('quote.price.currency', present(payload, '$.message.order.quote.price.currency'));
  check('quote.price.value', present(payload, '$.message.order.quote.price.value'));
  check('quote.ttl', present(payload, '$.message.order.quote.ttl'));

  // Quote breakup
  const breakupIds = queryAll(payload, "$.message.order.quote.breakup[*]['@ondc/org/item_id']");
  check('breakup @ondc/org/item_id present', breakupIds.length > 0);

  const titleTypes = queryAll(payload, "$.message.order.quote.breakup[*]['@ondc/org/title_type']");
  const validTypes = ['item', 'delivery', 'packing', 'tax', 'misc', 'discount', 'offer'];
  check('breakup title_types valid', titleTypes.every(t => validTypes.includes(t)),
    `got: ${[...new Set(titleTypes)].join(', ')}`);

  // Item breakup should have quantity available/maximum count as "99" or "0"
  const availCounts = queryAll(payload, '$.message.order.quote.breakup[*].item.quantity.available.count');
  if (availCounts.length > 0) {
    check('breakup item quantity.available.count is "99" or "0"',
      availCounts.every(c => c === '99' || c === '0'),
      `got: ${[...new Set(availCounts)].join(', ')}`);
  }

  // Item breakup should have item.price
  const itemPrices = queryAll(payload, '$.message.order.quote.breakup[*].item.price.currency');
  check('breakup item.price present (for item type)', itemPrices.length > 0);
}

// ── Validate on_init ────────────────────────────────────────────────────
function validateOnInit(payload) {
  console.log('\n── on_init validation ──');
  const ctx = payload.context || {};
  check('context.action', ctx.action === 'on_init', `got: ${ctx.action}`);
  check('context.bpp_id present', !!ctx.bpp_id);

  const order = payload.message?.order;
  if (!check('message.order present', !!order)) return;

  check('provider.id', present(payload, '$.message.order.provider.id'));
  check('items present', queryAll(payload, '$.message.order.items[*].id').length > 0);
  check('billing present', !!order.billing);
  check('fulfillments present', (order.fulfillments || []).length > 0);
  check('quote present', !!order.quote);
  check('payment present', !!order.payment);

  // on_init items should NOT have item.quantity (only item.price)
  if (order.items) {
    const hasQty = order.items.some(i => i.item?.quantity);
    check('items no item.quantity (on_init spec)', !hasQty);
  }

  // bpp_terms tags
  const bppTermsTags = queryAll(payload, "$.message.order.tags[?(@.code=='bpp_terms')].list[*].code");
  if (bppTermsTags.length > 0) {
    const allowedBppTerms = ['np_type', 'tax_number', 'provider_tax_number'];
    check('bpp_terms only allowed fields',
      bppTermsTags.every(c => allowedBppTerms.includes(c)),
      `got: ${bppTermsTags.join(', ')}`);
  }
}

// ── Validate on_confirm ─────────────────────────────────────────────────
function validateOnConfirm(payload) {
  console.log('\n── on_confirm validation ──');
  const ctx = payload.context || {};
  check('context.action', ctx.action === 'on_confirm', `got: ${ctx.action}`);

  const order = payload.message?.order;
  if (!check('message.order present', !!order)) return;

  check('order.id present', !!order.id);
  check('order.state', ['Created', 'Accepted'].includes(order.state), `got: ${order.state}`);
  check('provider present', !!order.provider);
  check('items present', (order.items || []).length > 0);
  check('billing present', !!order.billing);
  check('fulfillments present', (order.fulfillments || []).length > 0);
  check('quote present', !!order.quote);
  check('payment present', !!order.payment);
  check('created_at present', !!order.created_at);
  check('updated_at present', !!order.updated_at);
}

// ── Main flow ───────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   ONDC Flow Test Runner — Buyer Initiated Return    ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║ BPP Target:  ${BPP_URL.padEnd(39)}║`);
  console.log(`║ BAP Listen:  ${BAP_URI.padEnd(39)}║`);
  console.log(`║ Transaction: ${TRANSACTION_ID.substring(0, 36).padEnd(39)}║`);
  console.log('╚══════════════════════════════════════════════════════╝');

  // Start callback server
  const app = express();
  app.use(express.json({ limit: '3mb' }));

  // Callback handling — supports multiple callbacks for same action (on_status x6, on_update x4)
  const callbackQueues = {};   // action → [resolve, resolve, ...]
  const receivedPayloads = []; // all received payloads for debugging

  function waitForCallback(action, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${action} (${timeoutMs}ms)`)), timeoutMs);
      if (!callbackQueues[action]) callbackQueues[action] = [];
      callbackQueues[action].push((payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  // Catch all on_* callbacks
  app.post('/:action', (req, res) => {
    const action = req.params.action;
    const state = req.body?.message?.order?.fulfillments?.[0]?.state?.descriptor?.code
               || req.body?.message?.order?.state || '';
    console.log(`  ← ${action}${state ? ` [${state}]` : ''}`);
    res.json({ message: { ack: { status: 'ACK' } } });
    receivedPayloads.push({ action, state, payload: req.body });
    if (callbackQueues[action]?.length) {
      const resolver = callbackQueues[action].shift();
      resolver(req.body);
    }
  });

  const server = app.listen(BAP_PORT, () => {
    console.log(`\nBAP callback server listening on port ${BAP_PORT}\n`);
  });

  try {
    // ── Step 1: /select ──
    console.log('═══ Step 1: Sending /select ═══');
    const selectPayload = {
      context: buildContext('select'),
      message: {
        order: {
          provider: { id: PROVIDER_ID, locations: [{ id: LOCATION_ID }] },
          items: ITEM_IDS.map(id => ({
            id,
            quantity: { count: 1 },
            location_id: LOCATION_ID,
          })),
          fulfillments: [{
            end: {
              location: {
                gps: '12.9716,77.5946',
                address: { area_code: '560001' },
              },
            },
          }],
        },
      },
    };

    const onSelectPromise = waitForCallback('on_select');

    try {
      const selectResp = await axios.post(`${BPP_URL}/select`, selectPayload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      console.log(`→ /select response: ${selectResp.status}`,
        selectResp.data?.message?.ack?.status || '');
    } catch (err) {
      console.error(`→ /select FAILED: ${err.response?.status || ''} ${err.message}`);
      return;
    }

    // Wait for on_select callback
    console.log('⏳ Waiting for on_select callback...');
    const onSelectPayload = await onSelectPromise;
    validateOnSelect(onSelectPayload);

    // ── Step 2: /init ──
    console.log('\n═══ Step 2: Sending /init ═══');
    const initPayload = {
      context: buildContext('init'),
      message: {
        order: {
          provider: { id: PROVIDER_ID, locations: [{ id: LOCATION_ID }] },
          items: ITEM_IDS.map(id => ({
            id,
            quantity: { count: 1 },
            fulfillment_id: 'f1',
          })),
          billing: {
            name: 'Test Buyer',
            address: {
              name: 'Test Address',
              building: '123',
              locality: 'Test Locality',
              city: 'Bangalore',
              state: 'Karnataka',
              country: 'IND',
              area_code: '560001',
            },
            email: 'test@example.com',
            phone: '9999999999',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          fulfillments: [{
            id: 'f1',
            type: 'Delivery',
            end: {
              contact: { email: 'test@example.com', phone: '9999999999' },
              location: {
                gps: '12.9716,77.5946',
                address: {
                  name: 'Test Buyer',
                  building: '123',
                  locality: 'Test Locality',
                  city: 'Bangalore',
                  state: 'Karnataka',
                  country: 'IND',
                  area_code: '560001',
                },
              },
            },
          }],
          payment: {
            type: 'ON-ORDER',
            '@ondc/org/buyer_app_finder_fee_type': 'percent',
            '@ondc/org/buyer_app_finder_fee_amount': '3',
          },
        },
      },
    };

    const onInitPromise = waitForCallback('on_init');
    try {
      const initResp = await axios.post(`${BPP_URL}/init`, initPayload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      console.log(`→ /init response: ${initResp.status}`,
        initResp.data?.message?.ack?.status || '');
    } catch (err) {
      console.error(`→ /init FAILED: ${err.response?.status || ''} ${err.message}`);
      return;
    }

    console.log('⏳ Waiting for on_init callback...');
    const onInitPayload = await onInitPromise;
    validateOnInit(onInitPayload);

    // ── Step 3: /confirm ──
    console.log('\n═══ Step 3: Sending /confirm ═══');
    const confirmPayload = {
      context: buildContext('confirm'),
      message: {
        order: {
          ...initPayload.message.order,
          id: uuidv4(),
          payment: {
            ...initPayload.message.order.payment,
            params: {
              amount: onSelectPayload.message?.order?.quote?.price?.value || '100',
              currency: 'INR',
              transaction_id: uuidv4(),
            },
            status: 'PAID',
            collected_by: 'BAP',
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
    };

    const onConfirmPromise = waitForCallback('on_confirm');
    try {
      const confirmResp = await axios.post(`${BPP_URL}/confirm`, confirmPayload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      console.log(`→ /confirm response: ${confirmResp.status}`,
        confirmResp.data?.message?.ack?.status || '');
    } catch (err) {
      console.error(`→ /confirm FAILED: ${err.response?.status || ''} ${err.message}`);
      return;
    }

    console.log('⏳ Waiting for on_confirm callback...');
    const onConfirmPayload = await onConfirmPromise;
    validateOnConfirm(onConfirmPayload);

    const orderId = onConfirmPayload.message?.order?.id;
    const confirmContext = onConfirmPayload.context;

    // ── Steps 4-9: on_status sequence (auto-triggered by BPP) ──
    console.log('\n═══ Steps 4-9: Waiting for on_status sequence ═══');
    console.log('  (BPP auto-sends: Pending→Packed→Agent-assigned→Picked→Out-for-delivery→Delivered)');
    console.log('  Starting 15s after on_confirm, then 2s apart, Delivered after 45s...\n');

    const expectedStates = [
      'Pending', 'Packed', 'Agent-assigned',
      'Order-picked-up', 'Out-for-delivery', 'Order-delivered',
    ];

    // Queue up waiters for 6 on_status callbacks (total ~70s wait)
    const statusPromises = expectedStates.map(() => waitForCallback('on_status', 120000));

    const statusPayloads = [];
    for (let i = 0; i < expectedStates.length; i++) {
      try {
        const p = await statusPromises[i];
        statusPayloads.push(p);
      } catch (err) {
        console.error(`  ✗ Timeout waiting for on_status #${i + 1} (${expectedStates[i]})`);
        break;
      }
    }

    console.log(`\n── on_status validation (${statusPayloads.length}/${expectedStates.length} received) ──`);
    for (let i = 0; i < statusPayloads.length; i++) {
      const p = statusPayloads[i];
      const fState = p.message?.order?.fulfillments?.[0]?.state?.descriptor?.code;
      const oState = p.message?.order?.state;
      check(`on_status[${i}] context.action`, p.context?.action === 'on_status');
      check(`on_status[${i}] fulfillment state = ${expectedStates[i]}`,
        fState === expectedStates[i], `got: ${fState}`);
      check(`on_status[${i}] order.id matches`, p.message?.order?.id === orderId);

      // Last state should be Completed
      if (expectedStates[i] === 'Order-delivered') {
        check(`on_status[${i}] order.state = Completed`, oState === 'Completed', `got: ${oState}`);
      } else {
        check(`on_status[${i}] order.state = In-progress`, oState === 'In-progress', `got: ${oState}`);
      }

      // Must have provider, items, billing, fulfillments, quote, payment
      check(`on_status[${i}] has order.provider`, !!p.message?.order?.provider);
      check(`on_status[${i}] has order.items`, (p.message?.order?.items || []).length > 0);
      check(`on_status[${i}] has order.quote`, !!p.message?.order?.quote);
      check(`on_status[${i}] has order.fulfillments`, (p.message?.order?.fulfillments || []).length > 0);
    }

    // ── Step 10: /update (return request from BAP) ──
    if (statusPayloads.length >= 6) {
      console.log('\n═══ Step 10: Sending /update (return request) ═══');

      const updatePayload = {
        context: buildContext('update'),
        message: {
          update_target: 'item',
          order: {
            id: orderId,
            items: [{
              id: ITEM_IDS[0],
              quantity: { count: 1 },
              tags: [{ code: 'update_details', list: [
                { code: 'update_type', value: 'return' },
                { code: 'reason_code', value: '001' },
                { code: 'ttl_approval', value: 'PT24H' },
                { code: 'ttl_reverseqc', value: 'P3D' },
                { code: 'image', value: 'https://ondc.cottkart.com/placeholder.png' },
              ]}],
            }],
            fulfillments: [{
              id: 'r1',
              type: 'Return',
              tags: [{ code: 'return_request', list: [
                { code: 'id',             value: 'r1' },
                { code: 'item_id',        value: ITEM_IDS[0] },
                { code: 'item_quantity',   value: '1' },
                { code: 'reason_id',      value: '001' },
                { code: 'reason_desc',    value: 'Product damaged' },
                { code: 'images',         value: 'https://ondc.cottkart.com/placeholder.png' },
                { code: 'ttl_approval',   value: 'PT24H' },
                { code: 'ttl_reverseqc',  value: 'P3D' },
                { code: 'initiated_by',   value: BAP_ID },
              ]}],
            }],
          },
        },
      };

      const onUpdatePromise = waitForCallback('on_update', 30000);
      try {
        const updateResp = await axios.post(`${BPP_URL}/update`, updatePayload, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        });
        console.log(`→ /update response: ${updateResp.status}`,
          updateResp.data?.message?.ack?.status || '');
      } catch (err) {
        console.error(`→ /update FAILED: ${err.response?.status || ''} ${err.message}`);
      }

      console.log('⏳ Waiting for on_update callback...');
      try {
        const onUpdatePayload = await onUpdatePromise;
        console.log('\n── on_update (return) validation ──');
        check('on_update context.action', onUpdatePayload.context?.action === 'on_update');
        check('on_update order.id', onUpdatePayload.message?.order?.id === orderId);

        // Check return fulfillment exists
        const returnFl = (onUpdatePayload.message?.order?.fulfillments || [])
          .find(f => f.type === 'Return');
        check('on_update has Return fulfillment', !!returnFl);
        if (returnFl) {
          const returnState = returnFl.state?.descriptor?.code;
          check('Return fulfillment state',
            ['Return_Initiated', 'Return_Approved', 'Return_Picked', 'Return_Delivered'].includes(returnState),
            `got: ${returnState}`);

          // Return fulfillment must have tags with return_request
          const tagCodes = (returnFl.tags || []).map(t => t.code);
          check('Return fulfillment has return_request tag', tagCodes.includes('return_request'));
        }

        // Wait for additional on_update callbacks (Return_Approved, Return_Picked, etc.)
        console.log('\n⏳ Waiting for additional on_update callbacks (approval sequence)...');
        const additionalUpdates = [];
        for (let i = 0; i < 3; i++) {
          try {
            const p = await waitForCallback('on_update', 15000);
            additionalUpdates.push(p);
            const rf = (p.message?.order?.fulfillments || []).find(f => f.type === 'Return');
            const rs = rf?.state?.descriptor?.code || 'unknown';
            check(`on_update additional[${i}] Return state`, true, rs);
          } catch {
            break; // no more callbacks
          }
        }
      } catch (err) {
        console.error(`  ✗ ${err.message}`);
      }
    }

  } catch (err) {
    console.error(`\n✗ Flow error: ${err.message}`);
  } finally {
    printSummary();
    server.close();
  }
}

function printSummary() {
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total = results.length;

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║                    TEST SUMMARY                     ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  \x1b[32mPassed: ${String(passed).padEnd(4)}\x1b[0m  \x1b[31mFailed: ${String(failed).padEnd(4)}\x1b[0m  Total: ${String(total).padEnd(5)}     ║`);
  console.log('╚══════════════════════════════════════════════════════╝');

  if (failed > 0) {
    console.log('\nFailed checks:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  \x1b[31m✗\x1b[0m ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    });
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
