/**
 * ONDC Search Flow Test Runner — Flow 8A: Search and Custom Menu (Full Catalog City)
 *
 * Acts as a mock BAP: sends /search → receives on_search callback → validates against
 * Workbench automation-specifications validation rules.
 *
 * Usage:
 *   node test-search.js [--bpp-url http://localhost:4000]
 */
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const jp = require('jsonpath');

// ── Config ──────────────────────────────────────────────────────────────
const BAP_PORT  = 9091;
const BAP_ID    = 'test-bap-search.local';
const BAP_URI   = `http://localhost:${BAP_PORT}`;
const BPP_URL   = process.argv.includes('--bpp-url')
  ? process.argv[process.argv.indexOf('--bpp-url') + 1]
  : 'http://localhost:4000';

const TRANSACTION_ID = uuidv4();

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

function matchesRegex(value, regex) {
  try { return new RegExp(regex).test(value); }
  catch { return false; }
}

// ── Validate on_search ──────────────────────────────────────────────────
function validateOnSearch(payload) {
  console.log('\n── on_search context validation ──');
  const ctx = payload.context || {};
  check('context.action = on_search', ctx.action === 'on_search', `got: ${ctx.action}`);
  check('context.bpp_id present', !!ctx.bpp_id, `got: ${ctx.bpp_id}`);
  check('context.bpp_uri present', !!ctx.bpp_uri);
  check('context.bap_id preserved', ctx.bap_id === BAP_ID, `got: ${ctx.bap_id}`);
  check('context.transaction_id matches', ctx.transaction_id === TRANSACTION_ID);
  check('context.domain = ONDC:RET10', ctx.domain === 'ONDC:RET10');
  check('context.core_version = 1.2.0', ctx.core_version === '1.2.0');

  const catalog = payload.message?.catalog;
  if (!check('message.catalog present', !!catalog)) return;

  // ── bpp/descriptor ──
  console.log('\n── bpp/descriptor validation ──');
  const desc = catalog['bpp/descriptor'];
  check('bpp/descriptor present', !!desc);
  if (desc) {
    check('descriptor.name present', !!desc.name);
    check('descriptor.symbol present', !!desc.symbol);
    check('descriptor.short_desc present', !!desc.short_desc);
    check('descriptor.long_desc present', !!desc.long_desc);
    check('descriptor.images present', Array.isArray(desc.images) && desc.images.length > 0);

    // tags validation
    const tagCodes = (desc.tags || []).map(t => t.code);
    const validDescTags = ['bpp_terms'];
    check('descriptor tags codes valid', tagCodes.every(c => validDescTags.includes(c)),
      `got: ${tagCodes.join(', ')}`);

    // bpp_terms tag values
    const bppTerms = (desc.tags || []).find(t => t.code === 'bpp_terms');
    if (bppTerms) {
      const termCodes = (bppTerms.list || []).map(l => l.code);
      const validTermCodes = ['np_type', 'accept_bap_terms', 'collect_payment', 'mandatory_arbitration'];
      check('bpp_terms list codes valid', termCodes.every(c => validTermCodes.includes(c)),
        `got: ${termCodes.join(', ')}`);

      const npType = (bppTerms.list || []).find(l => l.code === 'np_type')?.value;
      check('np_type is ISN or MSN', ['ISN', 'MSN'].includes(npType), `got: ${npType}`);
    }
  }

  // ── bpp/fulfillments ──
  console.log('\n── bpp/fulfillments validation ──');
  const bppFulfillments = catalog['bpp/fulfillments'];
  check('bpp/fulfillments present', Array.isArray(bppFulfillments) && bppFulfillments.length > 0);
  if (bppFulfillments) {
    const fTypes = bppFulfillments.map(f => f.type);
    const validFTypes = ['Delivery', 'Self-Pickup', 'Buyer-Delivery'];
    check('bpp/fulfillments types valid', fTypes.every(t => validFTypes.includes(t)),
      `got: ${fTypes.join(', ')}`);
  }

  // ── bpp/providers ──
  console.log('\n── bpp/providers validation ──');
  const providers = catalog['bpp/providers'];
  if (!check('bpp/providers present', Array.isArray(providers) && providers.length > 0,
    `count: ${providers?.length || 0}`)) return;

  for (let pi = 0; pi < providers.length; pi++) {
    const p = providers[pi];
    const pfx = `provider[${pi}]`;
    console.log(`\n  ── ${pfx} (${p.id || 'no-id'}) ──`);

    check(`${pfx}.id present`, !!p.id);

    // time
    check(`${pfx}.time.label valid`, ['enable', 'disable'].includes(p.time?.label), `got: ${p.time?.label}`);
    const timeReg = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    check(`${pfx}.time.timestamp ISO format`, timeReg.test(p.time?.timestamp), `got: ${p.time?.timestamp}`);

    // descriptor
    check(`${pfx}.descriptor.name`, !!p.descriptor?.name);
    check(`${pfx}.descriptor.symbol`, !!p.descriptor?.symbol);
    check(`${pfx}.descriptor.short_desc`, !!p.descriptor?.short_desc);
    check(`${pfx}.descriptor.long_desc`, !!p.descriptor?.long_desc);
    check(`${pfx}.descriptor.images`, Array.isArray(p.descriptor?.images) && p.descriptor.images.length > 0);

    // ttl
    check(`${pfx}.ttl present`, !!p.ttl);

    // tags
    const provTagCodes = (p.tags || []).map(t => t.code);
    const validProvTags = ['timing', 'close_timing', 'serviceability', 'order_value', 'np_fees'];
    check(`${pfx} tags codes valid`, provTagCodes.every(c => validProvTags.includes(c)),
      `got: ${provTagCodes.join(', ')}`);

    // ── locations ──
    const locs = p.locations || [];
    check(`${pfx}.locations present`, locs.length > 0);
    for (let li = 0; li < locs.length; li++) {
      const loc = locs[li];
      const lpfx = `${pfx}.locations[${li}]`;

      check(`${lpfx}.id`, !!loc.id);

      // time
      check(`${lpfx}.time.label`, ['enable', 'disable'].includes(loc.time?.label));
      check(`${lpfx}.time.timestamp ISO`, timeReg.test(loc.time?.timestamp), `got: ${loc.time?.timestamp}`);

      // days
      if (loc.time?.days) {
        const daysReg = /^(?!.*\b([1-7]),.*\b\1\b)([1-7](,[1-7]){0,6})$/;
        check(`${lpfx}.time.days valid`, daysReg.test(loc.time.days), `got: ${loc.time.days}`);
      }

      // schedule.holidays
      if (loc.time?.schedule?.holidays?.length > 0) {
        const holReg = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
        check(`${lpfx} holidays date format`, loc.time.schedule.holidays.every(h => holReg.test(h)));
      }

      // schedule.times
      if (loc.time?.schedule?.times?.length > 0) {
        const timeHHMM = /^(?:[01]\d|2[0-3])[0-5]\d$/;
        check(`${lpfx} schedule.times HHmm format`, loc.time.schedule.times.every(t => timeHHMM.test(t)),
          `got: ${loc.time.schedule.times.join(', ')}`);
      }

      // range (start/end must be HHmm)
      if (loc.time?.range) {
        const rangeReg = /^([01]\d|2[0-3])[0-5]\d$/;
        check(`${lpfx}.time.range.start HHmm`, rangeReg.test(loc.time.range.start), `got: ${loc.time.range.start}`);
        check(`${lpfx}.time.range.end HHmm`, rangeReg.test(loc.time.range.end), `got: ${loc.time.range.end}`);
      }

      // Must have frequency+times OR range
      const hasFreq = !!loc.time?.frequency;
      const hasTimes = loc.time?.schedule?.times?.length > 0;
      const hasRange = !!loc.time?.range?.start;
      check(`${lpfx} has (frequency+times) or range`, (hasFreq && hasTimes) || hasRange);

      // GPS format
      const gpsReg = /^\d{2}\.\d{4,}\s*,\s*\d{2}\.\d{4,}$/;
      check(`${lpfx}.gps format`, gpsReg.test(loc.gps), `got: ${loc.gps}`);

      // address
      check(`${lpfx}.address.locality`, !!loc.address?.locality);
      check(`${lpfx}.address.street`, !!loc.address?.street);
      check(`${lpfx}.address.city`, !!loc.address?.city);
      check(`${lpfx}.address.state`, !!loc.address?.state);
      check(`${lpfx}.address.area_code`, !!loc.address?.area_code);

      // circle
      if (loc.circle) {
        check(`${lpfx}.circle.gps format`, gpsReg.test(loc.circle.gps));
        check(`${lpfx}.circle.radius`, !!loc.circle.radius?.unit && !!loc.circle.radius?.value);
      }
    }

    // ── fulfillments (provider-level) ──
    const pFulfs = p.fulfillments || [];
    check(`${pfx}.fulfillments present`, pFulfs.length > 0);
    for (const f of pFulfs) {
      check(`${pfx}.fulfillment(${f.id}).type valid`,
        ['Delivery', 'Self-Pickup', 'Buyer-Delivery'].includes(f.type), `got: ${f.type}`);
      if (f.contact?.phone) {
        check(`${pfx}.fulfillment(${f.id}).contact.phone 10-11 digits`,
          /^\d{10,11}$/.test(f.contact.phone), `got: ${f.contact.phone}`);
      }
      if (f.contact?.email) {
        check(`${pfx}.fulfillment(${f.id}).contact.email valid`,
          /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(f.contact.email));
      }
    }

    // ── items ──
    const items = p.items || [];
    check(`${pfx}.items present`, items.length > 0, `count: ${items.length}`);

    for (let ii = 0; ii < Math.min(items.length, 3); ii++) { // validate first 3 items
      const item = items[ii];
      const ipfx = `${pfx}.item[${ii}](${item.id})`;

      check(`${ipfx}.id present`, !!item.id);
      check(`${ipfx}.descriptor.name`, !!item.descriptor?.name);
      check(`${ipfx}.descriptor.code`, !!item.descriptor?.code);
      check(`${ipfx}.descriptor.symbol`, !!item.descriptor?.symbol);
      check(`${ipfx}.descriptor.short_desc`, !!item.descriptor?.short_desc);
      check(`${ipfx}.descriptor.long_desc`, !!item.descriptor?.long_desc);
      check(`${ipfx}.descriptor.images`, Array.isArray(item.descriptor?.images) && item.descriptor.images.length > 0);

      // price
      check(`${ipfx}.price.currency = INR`, item.price?.currency === 'INR');
      check(`${ipfx}.price.value present`, !!item.price?.value);
      check(`${ipfx}.price.maximum_value present`, !!item.price?.maximum_value);

      // quantity
      check(`${ipfx}.quantity.available.count`, !!item.quantity?.available?.count);
      check(`${ipfx}.quantity.maximum.count`, !!item.quantity?.maximum?.count);
      check(`${ipfx}.quantity.unitized.measure`, !!item.quantity?.unitized?.measure?.unit);

      // required ONDC fields
      check(`${ipfx}.category_id`, !!item.category_id);
      check(`${ipfx}.fulfillment_id`, !!item.fulfillment_id);
      check(`${ipfx}.location_id`, !!item.location_id);

      check(`${ipfx}.@ondc/org/returnable`, item['@ondc/org/returnable'] !== undefined);
      check(`${ipfx}.@ondc/org/cancellable`, item['@ondc/org/cancellable'] !== undefined);
      check(`${ipfx}.@ondc/org/return_window`, !!item['@ondc/org/return_window']);
      check(`${ipfx}.@ondc/org/time_to_ship`, !!item['@ondc/org/time_to_ship']);
      check(`${ipfx}.@ondc/org/available_on_cod`, item['@ondc/org/available_on_cod'] !== undefined);

      // consumer_care format: "Name,email,phone"
      const cc = item['@ondc/org/contact_details_consumer_care'];
      check(`${ipfx}.consumer_care present`, !!cc);
      if (cc) {
        const ccParts = cc.split(',');
        check(`${ipfx}.consumer_care format (Name,email,phone)`, ccParts.length >= 3,
          `got ${ccParts.length} parts: ${cc}`);
      }

      // statutory_reqs
      const stat = item['@ondc/org/statutory_reqs_packaged_commodities'];
      check(`${ipfx}.statutory_reqs_packaged_commodities`, !!stat);
      if (stat) {
        check(`${ipfx}.stat.manufacturer_or_packer_name`, !!stat.manufacturer_or_packer_name);
        check(`${ipfx}.stat.manufacturer_or_packer_address`, !!stat.manufacturer_or_packer_address);
        check(`${ipfx}.stat.common_or_generic_name`, !!stat.common_or_generic_name_of_commodity);
        check(`${ipfx}.stat.month_year_of_manufacture`, !!stat.month_year_of_manufacture_packing_import);
      }

      // time
      check(`${ipfx}.time.label`, item.time?.label === 'enable');
      check(`${ipfx}.time.timestamp`, !!item.time?.timestamp);

      // tags
      const itemTagCodes = (item.tags || []).map(t => t.code);
      check(`${ipfx} has origin tag`, itemTagCodes.includes('origin'));
      check(`${ipfx} has veg_nonveg tag`, itemTagCodes.includes('veg_nonveg'));
    }

    // ── serviceability tag ──
    const svcTag = (p.tags || []).find(t => t.code === 'serviceability');
    if (svcTag) {
      const svcCodes = (svcTag.list || []).map(l => l.code);
      check(`${pfx} serviceability has location`, svcCodes.includes('location'));
      check(`${pfx} serviceability has category`, svcCodes.includes('category'));
      check(`${pfx} serviceability has type`, svcCodes.includes('type'));
      check(`${pfx} serviceability has val`, svcCodes.includes('val'));
      check(`${pfx} serviceability has unit`, svcCodes.includes('unit'));
    }

    // ── timing tag ──
    const timingTag = (p.tags || []).find(t => t.code === 'timing');
    if (timingTag) {
      const timCodes = (timingTag.list || []).map(l => l.code);
      check(`${pfx} timing has type`, timCodes.includes('type'));
      check(`${pfx} timing has location`, timCodes.includes('location'));
      check(`${pfx} timing has day_from`, timCodes.includes('day_from'));
      check(`${pfx} timing has day_to`, timCodes.includes('day_to'));
      check(`${pfx} timing has time_from`, timCodes.includes('time_from'));
      check(`${pfx} timing has time_to`, timCodes.includes('time_to'));
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   Flow 8A: Search & Custom Menu (Full Catalog)      ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║ BPP Target:  ${BPP_URL.padEnd(39)}║`);
  console.log(`║ BAP Listen:  ${BAP_URI.padEnd(39)}║`);
  console.log(`║ Transaction: ${TRANSACTION_ID.substring(0, 36).padEnd(39)}║`);
  console.log('╚══════════════════════════════════════════════════════╝');

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Callback handler
  let onSearchResolve;
  const onSearchPromise = new Promise((resolve, reject) => {
    onSearchResolve = resolve;
    setTimeout(() => reject(new Error('Timeout waiting for on_search (15s)')), 15000);
  });

  app.post('/on_search', (req, res) => {
    const provCount = req.body?.message?.catalog?.['bpp/providers']?.length || 0;
    const itemCount = req.body?.message?.catalog?.['bpp/providers']?.[0]?.items?.length || 0;
    console.log(`  ← on_search [${provCount} providers, ${itemCount} items]`);
    res.json({ message: { ack: { status: 'ACK' } } });
    onSearchResolve(req.body);
  });

  const server = app.listen(BAP_PORT, () => {
    console.log(`\nBAP callback server listening on port ${BAP_PORT}\n`);
  });

  try {
    // ── Step 1: Send /search ──
    console.log('═══ Step 1: Sending /search (full catalog, city=std:044) ═══');
    const searchPayload = {
      context: {
        domain: 'ONDC:RET10',
        country: 'IND',
        city: 'std:044',
        action: 'search',
        core_version: '1.2.0',
        bap_id: BAP_ID,
        bap_uri: BAP_URI,
        transaction_id: TRANSACTION_ID,
        message_id: uuidv4(),
        timestamp: new Date().toISOString(),
        ttl: 'PT30S',
      },
      message: {
        intent: {
          payment: {
            '@ondc/org/buyer_app_finder_fee_type': 'percent',
            '@ondc/org/buyer_app_finder_fee_amount': '3',
          },
          tags: [{
            code: 'bap_terms',
            list: [
              { code: 'static_terms', value: 'https://github.com/ONDC-Official/NP-Static-Terms/buyerNP_BNP/1.0/tc.pdf' },
              { code: 'static_terms_new', value: 'https://github.com/ONDC-Official/NP-Static-Terms/buyerNP_BNP/1.0/tc.pdf' },
              { code: 'effective_date', value: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString() },
            ],
          }],
        },
      },
    };

    try {
      const resp = await axios.post(`${BPP_URL}/search`, searchPayload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      console.log(`→ /search response: ${resp.status}`, resp.data?.message?.ack?.status || '');
    } catch (err) {
      console.error(`→ /search FAILED: ${err.response?.status || ''} ${err.message}`);
      return;
    }

    // ── Step 2: Wait for on_search callback ──
    console.log('⏳ Waiting for on_search callback...');
    const onSearchPayload = await onSearchPromise;
    validateOnSearch(onSearchPayload);

  } catch (err) {
    console.error(`\n✗ Flow error: ${err.message}`);
  } finally {
    // Print summary
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

    server.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
