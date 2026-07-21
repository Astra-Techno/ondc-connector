const { pool } = require('../config/database');
const { saveONDCOrder } = require('./order.controller');
const logger = require('../utils/logger');
const axios  = require('axios');
const { v4: uuidv4 } = require('uuid');
const {
  buildQuote,
  buildOrderObject,
  getTenantByBppId,
  sendCallback,
  updateOrderStatus,
  resolveOndcConfig,
  buildCallbackUrl,
} = require('../services/ondc/order.service');
const cottKartOrder = require('../services/cloudkart/order.service');
const { ack, nack, buildAckBody } = require('../utils/response');
const { pushTxnLog } = require('../services/ondc/logPublisher.service');
const { createAuthHeader } = require('../utils/crypto');
const { searchLogistics } = require('../services/logistics/lsp.service');
const {
  logisticsOrderCache,
  startLogisticsFlow,
  relayTrackToLogistics,
  relayStatusToLogistics,
  markRetailOrderCancelled,
  cancelLogisticsOrder,
} = require('./logistics.controller');

// In-memory cache: order_id → { order, context } (for on_status/on_update/on_cancel callbacks)
const confirmedOrderCache = new Map();
let lastConfirmedOrderId = null; // track most recent for /latest shortcut
// Track cancelled orders so auto-sequence can abort
const cancelledOrders = new Set();
// Forced out-of-stock items for Flow 5 testing (cleared on server restart or via trigger)
const forcedOutOfStockItems = new Set();

// In-memory cache: issue_id → { issue, context } (for proactive on_issue_status)
const issueCache = new Map();
let lastIssueId = null;

// ─── constants ───────────────────────────────────────────────────────────────

const CANCELLATION_TERMS = [
  {
    fulfillment_state: { descriptor: { code: 'Pending',         short_desc: 'Pending'         } },
    refund_eligible:   true,
    reason_required:   false,
    cancellation_fee:  { percentage: '0',   amount: { currency: 'INR', value: '0.00'    } },
  },
  {
    fulfillment_state: { descriptor: { code: 'Order-picked-up', short_desc: 'Order-picked-up' } },
    refund_eligible:   false,
    reason_required:   true,
    cancellation_fee:  { percentage: '100', amount: { currency: 'INR', value: '0.00'    } },
  },
];

const ORDER_TAGS = [{
  code: 'bpp_terms',
  list: [
    { code: 'max_liability',           value: '2'        },
    { code: 'max_liability_cap',       value: '10000.00' },
    { code: 'mandatory_arbitration',   value: 'false'    },
    { code: 'court_jurisdiction',      value: 'Bengaluru'},
    { code: 'delay_interest',          value: '1000.00'  },
    { code: 'np_type',                 value: 'MSN'      },
    { code: 'accept_bap_terms',        value: 'Y'        },
  ],
}];

// RSF 2.0 requires settlement_id, settlement_amount, settlement_timestamp per settlement
const buildSettlementDetails = (settlementAmount = '0.00') => [{
  settlement_counterparty:    'buyer-app',
  settlement_phase:           'sale-amount',
  settlement_type:            'upi',
  settlement_id:              uuidv4(),
  settlement_amount:          String(settlementAmount),
  settlement_timestamp:       new Date().toISOString(),
  beneficiary_name:           'CottKart Pvt Ltd',
  settlement_bank_account_no: '1234567890',
  settlement_ifsc_code:       'ICIC0001234',
  bank_name:                  'ICICI Bank',
  branch_name:                'MG Road',
  upi_address:                'cottkart@upi',
}];

// Normalize GPS to at least 6 decimal places
const normalizeGps = (gps) => {
  if (!gps) return '12.914082,77.638980';
  const [lat, lng] = gps.split(',').map(Number);
  if (isNaN(lat) || isNaN(lng)) return '12.914082,77.638980';
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
};

// Build a fulfillment object with all required ONDC fields (start/end location, provider_name, etc.)
const buildFulfillmentWithLocation = (f, vendor, stateCode, now) => {
  const t1h  = new Date(new Date(now).getTime() +  1 * 3600 * 1000).toISOString();
  const t2h  = new Date(new Date(now).getTime() +  2 * 3600 * 1000).toISOString();
  const t24h = new Date(new Date(now).getTime() + 24 * 3600 * 1000).toISOString();
  const t48h = new Date(new Date(now).getTime() + 48 * 3600 * 1000).toISOString();
  const phone = (vendor?.phone || '9999999999').replace(/^\+91/, '');
  const gps   = normalizeGps(vendor?.gps);

  return {
    ...f,
    id:       f.id   || 'f1',
    type:     f.type || 'Delivery',
    state:    { descriptor: { code: stateCode } },
    tracking: false,
    '@ondc/org/provider_name': vendor?.business_name || '',
    '@ondc/org/category':      f['@ondc/org/category'] || 'Grocery',
    '@ondc/org/TAT':           f['@ondc/org/TAT']      || 'PT24H',
    start: {
      location: {
        id:  'l1',
        gps,
        descriptor: { name: vendor?.business_name || 'Store' },
        address: {
          locality:  vendor?.address   || vendor?.city || 'Bengaluru',
          city:      vendor?.city      || 'Bengaluru',
          area_code: vendor?.pincode   || '560001',
          state:     vendor?.state     || 'Karnataka',
        },
      },
      time:    { range: { start: t1h, end: t2h }, timestamp: t1h },
      instructions: {
        code: 'ready_for_pickup',
        name: 'Ready for pickup',
        short_desc: 'Order is ready for pickup',
        long_desc: 'Order has been packed and is ready for pickup by logistics',
        images: ['https://ondc.cottkart.com/pickup-instructions.png'],
      },
      contact: { phone, email: vendor?.email || 'support@store.in' },
    },
    end: {
      ...(f.end || {}),
      time: { range: { start: t24h, end: t48h }, timestamp: t48h },
    },
  };
};

// Flow 3A — merchant partial cancel on_update (ONDC spec: Cancel fulfillment + precancel_state)
const buildPartialCancelUpdatePayload = (order, vendor, confirmTimestamp) => {
  const now = new Date().toISOString();
  const subscriberId = process.env.ONDC_SUBSCRIBER_ID || 'ondc.cottkart.com';
  const allItems = order.items || [];
  const cancelledItem = allItems[0];
  const remainingItems = allItems.length > 1 ? allItems.slice(1) : allItems;
  const cancelledQty = cancelledItem?.quantity?.count || 1;
  const cancelledPrice = parseFloat(
    order.quote?.breakup?.find(b => b['@ondc/org/item_id'] === cancelledItem?.id)?.item?.price?.value
    || cancelledItem?.price?.value || '0'
  );
  const cancelledLineTotal = (cancelledPrice * cancelledQty).toFixed(2);

  // Recalculate quote: remove cancelled item, keep delivery + remaining items
  const originalBreakup = order.quote?.breakup || [];
  const updatedBreakup = originalBreakup.filter(b =>
    !(b['@ondc/org/title_type'] === 'item' && b['@ondc/org/item_id'] === cancelledItem?.id)
  );
  const updatedTotal = updatedBreakup.reduce((sum, b) => sum + parseFloat(b.price?.value || 0), 0).toFixed(2);

  // Cancel fulfillment (type "Cancel", state "Cancelled") — separate from Delivery
  const cancelFulfillmentId = 'c1';
  const cancelFulfillment = {
    id:    cancelFulfillmentId,
    type:  'Cancel',
    state: { descriptor: { code: 'Cancelled' } },
    tags: [
      {
        code: 'cancel_request',
        list: [
          { code: 'reason_id',    value: '001' },
          { code: 'initiated_by', value: subscriberId },
        ],
      },
      {
        code: 'quote_trail',
        list: [
          { code: 'type',     value: 'item' },
          { code: 'id',       value: cancelledItem?.id || 'P001' },
          { code: 'currency', value: 'INR' },
          { code: 'value',    value: `-${cancelledLineTotal}` },
        ],
      },
    ],
  };

  // Delivery fulfillment keeps its precancel state (Packed) + precancel_state tag
  const preCancelState = 'Packed';
  const deliveryFulfillments = (order.fulfillments || [{ id: 'f1', type: 'Delivery' }]).map(f => ({
    ...buildFulfillmentWithLocation(f, vendor, preCancelState, now),
    tags: [
      {
        code: 'cancel_request',
        list: [
          { code: 'reason_id',    value: '001' },
          { code: 'initiated_by', value: subscriberId },
        ],
      },
      {
        code: 'precancel_state',
        list: [
          { code: 'fulfillment_state', value: preCancelState },
          { code: 'updated_at',        value: confirmTimestamp || order.updated_at || now },
        ],
      },
    ],
  }));

  // Items: remaining items keep their fulfillment_id, cancelled item points to Cancel fulfillment
  const itemsPayload = [
    ...remainingItems.map(i => ({ ...i })),
    ...(cancelledItem ? [{
      ...cancelledItem,
      fulfillment_id: cancelFulfillmentId,
      tags: [{ code: 'cancellation', list: [{ code: 'reason_id', value: '001' }] }],
    }] : []),
  ];

  return {
    id:       order.id,
    state:    'In-progress',
    provider: order.provider,
    items:    itemsPayload,
    billing:  order.billing,
    quote: {
      price:   { currency: 'INR', value: updatedTotal },
      breakup: updatedBreakup,
      ttl:     order.quote?.ttl || 'P1D',
    },
    payment: {
      ...(order.payment || {}),
      '@ondc/org/buyer_app_finder_fee_type':   'percent',
      '@ondc/org/buyer_app_finder_fee_amount': '3',
      '@ondc/org/settlement_basis':             'return_window_expiry',
      '@ondc/org/settlement_window':            'P1D',
      '@ondc/org/withholding_amount':           '10.00',
      '@ondc/org/settlement_details':           buildSettlementDetails(),
      status: 'PAID',
    },
    fulfillments: [...deliveryFulfillments, cancelFulfillment],
    tags: ORDER_TAGS,
    created_at: order.created_at || now,
    updated_at: confirmTimestamp || order.updated_at || now,
  };
};

const sendPartialCancelOnUpdate = async (context, order, vendor, tenant, confirmTimestamp) => {
  const cancelPayload = buildPartialCancelUpdatePayload(order, vendor, confirmTimestamp);
  // Use a fresh message_id — this is a proactive BPP-initiated callback, NOT a direct response
  // to a specific BAP request, so it must not reuse the confirm's message_id
  await sendCallback(context.bap_uri, 'on_update', { ...context, message_id: uuidv4() }, { order: cancelPayload }, tenant);
  logger.info('on_update (Cancelled/partial) sent', { order_id: order.id, txn: context?.transaction_id });
};

// Fetch vendor row from DB by provider id
const fetchVendorForOrder = async (tenantId, providerId) => {
  if (!providerId) return null;
  try {
    const [rows] = await pool.query(
      `SELECT * FROM vendors WHERE tenant_id = ? AND (external_vendor_id = ? OR id = ?) LIMIT 1`,
      [tenantId, String(providerId), providerId]
    );
    return rows[0] || null;
  } catch (_) { return null; }
};

// ─── helpers ─────────────────────────────────────────────────────────────────

// Get all active tenants (used only by /search which is broadcast)
const getActiveTenants = async () => {
  const [rows] = await pool.query(`
    SELECT t.*, oc.subscriber_id, oc.subscriber_url,
           oc.signing_private_key, oc.unique_key_id
    FROM tenants t
    JOIN tenant_ondc_config oc ON oc.tenant_id = t.id
    WHERE t.status = 'active' AND oc.is_active = 1
  `);
  // Deduplicate by tenant id — prevents multiple on_search with same message_id
  // if a tenant has more than one active tenant_ondc_config row
  const seen = new Set();
  return rows.filter(r => seen.has(r.id) ? false : seen.add(r.id));
};

// Build ONDC catalog from DB for a tenant
// contextCity: specific city code (e.g. "std:044"), null = no filter, "*" = all cities (treated as no filter)
const buildCatalog = async (tenantId, ondcConfig, contextCity) => {
  try {
    // city="*" means "all cities" — treat as no filter
    const cityFilter = (contextCity && contextCity !== '*') ? contextCity : null;
    // Filter vendors strictly by city — prevents GCR catalog_rejection for area_code/city mismatch.
    // Vendors with NULL std_city_code are excluded from city-specific searches (they have no registered city).
    const [vendors] = await pool.query(
      `SELECT * FROM vendors WHERE tenant_id = ? AND status = 'active'
       AND (? IS NULL OR std_city_code = ?)`,
      [tenantId, cityFilter, cityFilter]
    );

    const providers = [];

    for (const vendor of vendors) {
      const [products] = await pool.query(
        `SELECT * FROM products
         WHERE tenant_id = ? AND vendor_id = ? AND is_active = 1
         LIMIT 100`,
        [tenantId, vendor.id]
      );

      if (!products.length) continue;

      const now = new Date().toISOString();
      const defaultImg = 'https://ondc.cottkart.com/assets/placeholder.png';
      const itemImages = (p) => {
        try {
          if (p.images && p.images !== '[]' && p.images !== 'null') {
            const raw = JSON.parse(p.images);
            if (Array.isArray(raw) && raw.length) {
              return raw.map(i => typeof i === 'string' ? i : (i.url || defaultImg));
            }
          }
        } catch (e) {}
        if (p.image_url) return [p.image_url];
        return [defaultImg];
      };

      const items = products.map(p => {
        const imgs = itemImages(p);
        return {
        id: p.external_product_id,
        time: { label: 'enable', timestamp: now },
        descriptor: {
          name:       p.name,
          symbol:     imgs[0] || defaultImg,
          code:       `5:${p.external_product_id}`,
          short_desc: p.short_description || p.name,
          long_desc:  p.description       || p.name,
          images:     imgs,
        },
        price: {
          currency:      p.currency || 'INR',
          value:         String(p.price),
          maximum_value: String(p.mrp || p.price),
        },
        quantity: {
          unitized: { measure: { unit: p.unit || 'unit', value: '1' } },
          available: { count: (p.stock > 0) ? '99' : '0' },
          maximum:   { count: String(Math.max(p.stock || 0, 0)) },
        },
        category_id:    p.category || 'Snacks, Dry Fruits, Nuts',
        fulfillment_id: 'f1',
        location_id:    'l1',
        '@ondc/org/returnable':           Boolean(p.is_returnable),
        '@ondc/org/cancellable':          Boolean(p.is_cancellable),
        '@ondc/org/return_window':        p.return_window || 'P7D',
        '@ondc/org/seller_pickup_return': false,
        '@ondc/org/time_to_ship':         p.time_to_ship  || 'PT45M',
        '@ondc/org/available_on_cod':     Boolean(p.available_on_cod),
        '@ondc/org/contact_details_consumer_care': `phone:${(vendor.phone || '').replace(/^\+91/, '')},email:${vendor.email || ''}`,
        '@ondc/org/statutory_reqs_packaged_commodities': {
          manufacturer_or_packer_name:                  vendor.business_name,
          manufacturer_or_packer_address:               [vendor.address, vendor.city].filter(Boolean).join(', ') || vendor.city || 'India',
          common_or_generic_name_of_commodity:          p.name,
          net_quantity_or_measure_of_commodity_in_pkg:  `1 ${p.unit || 'unit'}`,
          month_year_of_manufacture_packing_import:     new Date().toISOString().substring(0, 7),
          // imported_product_country_of_origin removed — not allowed in v1.2.0 schema
        },
        tags: [
          { code: 'origin', list: [{ code: 'country', value: 'IND' }] },
        ],
      };});

      // Ensure GPS has 6+ decimal places
      const rawGps = vendor.gps || '13.0827,80.2707';
      const gps6 = rawGps.split(',').map(c => {
        const parts = c.trim().split('.');
        return parts[0] + '.' + (parts[1] || '0').padEnd(6, '0');
      }).join(',');
      const providerImg = vendor.logo_url || defaultImg;

      providers.push({
        id: vendor.external_vendor_id || String(vendor.id),
        time: { label: 'enable', timestamp: now },
        descriptor: {
          name:       vendor.business_name,
          symbol:     providerImg,
          short_desc: vendor.business_name,
          long_desc:  vendor.description || vendor.business_name,
          images:     [providerImg],
        },
        ttl: 'P1D',
        '@ondc/org/fssai_license_no': vendor.fssai_number || '',
        locations: [{
          id:  'l1',
          gps: gps6,
          address: {
            locality:  vendor.address || vendor.city || 'Main Road',
            street:    vendor.street || vendor.address || 'Main Road',
            city:      vendor.city    || 'Chennai',
            state:     vendor.state   || 'Tamil Nadu',
            country:   'IND',
            area_code: vendor.pincode || '600001',
          },
          time: {
            label:     'enable',
            timestamp: now,
            days:      '1,2,3,4,5,6,7',
            schedule:  {
              holidays:  ['2026-01-26', '2026-08-15'],
              frequency: 'PT4H',
              times:     ['0900', '1300', '1700', '2100'],
            },
            range:     { start: '0900', end: '2100' },
          },
          circle: {
            gps:    gps6,
            radius: { unit: 'km', value: '10' },
          },
        }],
        items,
        fulfillments: [{
          id:   'f1',
          type: 'Delivery',
          contact: { phone: (vendor.phone || '').replace(/^\+91/, ''), email: vendor.email || '' },
        }],
        tags: [
          {
            code: 'serviceability',
            list: [
              { code: 'location', value: 'l1' },
              { code: 'category', value: 'Grocery' },
              { code: 'type',     value: '10' },
              { code: 'val',      value: '10' },
              { code: 'unit',     value: 'km' },
            ],
          },
          {
            code: 'timing',
            list: [
              { code: 'day_from',  value: '1'    },
              { code: 'day_to',    value: '7'    },
              { code: 'time_from', value: '0900' },
              { code: 'time_to',   value: '2100' },
            ],
          },
        ],
      });
    }

    const bppDescriptor = {
      name:       ondcConfig?.subscriber_id || 'ONDC Connector',
      symbol:     'https://ondc.cottkart.com/assets/logo.png',
      short_desc: 'ONDC Seller Platform',
      long_desc:  'Multi-vendor ONDC Seller Platform powered by CottKart',
      images:     ['https://ondc.cottkart.com/assets/logo.png'],
      tags: [
        {
          code: 'bpp_terms',
          list: [
            { code: 'np_type',         value: 'MSN' },
            { code: 'accept_bap_terms', value: 'Y'  },
          ],
        },
      ],
    };

    return {
      'bpp/descriptor':   bppDescriptor,
      'bpp/providers':    providers,
      'bpp/fulfillments': [{ id: 'f1', type: 'Delivery' }],
    };
  } catch (err) {
    logger.error('buildCatalog failed:', err.message);
    return null;
  }
};

// Env-only tenant stub when DB lookup fails (signing keys often live in .env)
const envTenantFallback = () => ({
  id: null,
  tenant_id: null,
  subscriber_id:       process.env.ONDC_SUBSCRIBER_ID,
  subscriber_url:      process.env.ONDC_SUBSCRIBER_URL,
  signing_private_key: process.env.ONDC_SIGNING_PRIVATE_KEY,
  unique_key_id:       process.env.ONDC_UNIQUE_KEY_ID,
});

const resolveTenant = async (bppId) => {
  const tenant = await getTenantByBppId(bppId);
  if (tenant) return tenant;
  logger.warn('No tenant in DB — using env ONDC config', { bpp_id: bppId });
  return envTenantFallback();
};

// Send on_search callback (signed)
const sendOnSearch = async (context, catalog, ondcConfig) => {
  const config = resolveOndcConfig(ondcConfig);
  const callbackUrl = buildCallbackUrl(context.bap_uri, 'on_search');
  try {
    const { createAuthHeader } = require('../utils/crypto');
    if (!callbackUrl) { logger.warn('on_search: no bap_uri in context'); return; }
    const payload = {
      context: {
        ...context,
        action:    'on_search',
        bpp_id:    config.subscriber_id,
        bpp_uri:   config.subscriber_url,
        timestamp: new Date().toISOString(),
        // message_id must match the search request's message_id (Beckn protocol)
        ttl:       'PT30S',
      },
      message: { catalog },
    };

    const headers = { 'Content-Type': 'application/json' };
    if (config.signing_private_key) {
      try {
        headers['Authorization'] = createAuthHeader(
          config.signing_private_key,
          config.subscriber_id,
          config.unique_key_id,
          payload
        );
      } catch (e) {
        logger.warn('on_search auth header skipped:', e.message);
      }
    }

    logger.info(`Sending on_search → ${callbackUrl}`);
    const response = await axios.post(callbackUrl, payload, { headers, timeout: 10000 });
    logger.info(`on_search sent to ${callbackUrl}: ${response.status}`);
    pushTxnLog('on_search', payload).catch(() => {});
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    logger.error(`on_search callback failed to ${callbackUrl} [${status || err.code || 'no-response'}]: ${detail}`);
  }
};

// ─── handlers ────────────────────────────────────────────────────────────────

const handleSearch = async (req, res) => {
  try {
    const { context } = req.body;
    logger.info('ONDC /search received', { bap_id: context?.bap_id, domain: context?.domain, city: context?.city });

    await ack(res, context);

    // Only respond to grocery domain — our catalog is ONDC:RET10
    if (context?.domain && context.domain !== 'ONDC:RET10') {
      logger.info(`Ignoring /search for unsupported domain: ${context.domain}`);
      return;
    }

    const tenants = await getActiveTenants();
    if (!tenants.length) { logger.info('No active tenants for /search'); return; }

    // Detect incremental vs full catalog request
    const intentTags  = req.body?.message?.intent?.tags || [];
    const isIncremental = intentTags.some(t => t.code === 'catalog_inc');

    for (const tenant of tenants) {
      const ondcConfig = resolveOndcConfig(tenant);
      const catalog    = await buildCatalog(tenant.id, ondcConfig, context?.city);
      if (!catalog) continue;
      // For incremental search: always send (even empty providers — means no changes)
      // For full catalog search: only send if we have providers to return
      if (isIncremental || catalog['bpp/providers']?.length) {
        await sendOnSearch(context, catalog, ondcConfig);
      }
    }
  } catch (err) {
    logger.error('handleSearch failed:', err.message);
  }
};

const handleSelect = async (req, res) => {
  const body    = req.body;
  const context = body.context;
  logger.info('ONDC /select received', { transaction_id: context?.transaction_id });

  await ack(res, context);

  setImmediate(async () => {
    let tenant = null;
    try {
      tenant = await resolveTenant(context?.bpp_id);
      if (!tenant?.id && !process.env.ONDC_SIGNING_PRIVATE_KEY) {
        logger.error('/select: no tenant and no ONDC_SIGNING_PRIVATE_KEY in env');
        return;
      }

      const order        = body.message?.order || {};
      const items        = order.items          || [];
      const fulfillments = order.fulfillments   || [];

      const tenantId = tenant.id || tenant.tenant_id;
      const { quote, outOfStockItems: dbOutOfStock } = tenantId
        ? await buildQuote(items, tenantId)
        : { quote: { price: { currency: 'INR', value: '30' }, breakup: [], ttl: 'P1D' }, outOfStockItems: [] };

      // Merge forced out-of-stock items (Flow 5 testing via /trigger/set-out-of-stock)
      const outOfStockItems = [...dbOutOfStock];
      for (const item of items) {
        if (forcedOutOfStockItems.has(item.id) && !outOfStockItems.includes(item.id)) {
          outOfStockItems.push(item.id);
        }
      }

      let providerName = '';
      try {
        const providerId = order.provider?.id;
        if (providerId) {
          const [vRows] = await pool.query(
            `SELECT business_name FROM vendors WHERE tenant_id = ? AND (external_vendor_id = ? OR id = ?) LIMIT 1`,
            [tenantId, String(providerId), providerId]
          );
          providerName = vRows[0]?.business_name || '';
        }
      } catch (_) {}

      const payload = {
        order: {
          provider: order.provider,
          items: items.map(i => ({ ...i, fulfillment_id: i.fulfillment_id || 'f1' })),
          quote,
          fulfillments: (fulfillments.length > 0 ? fulfillments : [{ id: 'f1', type: 'Delivery' }]).map(f => ({
            ...f,
            id: f.id || 'f1',
            type: f.type || 'Delivery',
            state: f.state || { descriptor: { code: 'Serviceable' } },
            '@ondc/org/TAT': 'PT24H',
            '@ondc/org/category': f['@ondc/org/category'] || 'Grocery',
            '@ondc/org/provider_name': f['@ondc/org/provider_name'] || providerName,
            tracking: false,
          })),
        },
      };

      // Only include error block when items are actually out of stock (ONDC spec DOMAIN-ERROR 40002)
      if (outOfStockItems.length > 0) {
        payload.error = {
          type: 'DOMAIN-ERROR',
          code: '40002',
          message: `Items out of stock: ${outOfStockItems.join(', ')}`,
        };
        logger.warn('Out of stock items in /select', { outOfStockItems });
      }

      await sendCallback(context.bap_uri, 'on_select', context, payload, tenant);
    } catch (err) {
      logger.error('handleSelect processing failed:', err.message);
      if (context?.bap_uri) {
        await sendCallback(context.bap_uri, 'on_select', context, {
          error: { type: 'CORE-ERROR', code: '50000', message: err.message },
        }, tenant || envTenantFallback()).catch(e => logger.error('on_select error callback failed:', e.message));
      }
    }
  });
};

const handleInit = async (req, res) => {
  const body    = req.body;
  const context = body.context;
  logger.info('ONDC /init received', { transaction_id: context?.transaction_id });

  await ack(res, context);

  setImmediate(async () => {
    let tenant = null;
    try {
      tenant = await resolveTenant(context?.bpp_id);
      if (!tenant?.id && !process.env.ONDC_SIGNING_PRIVATE_KEY) return;

      const order = body.message?.order || {};
      const items = order.items         || [];

      const tenantId = tenant.id || tenant.tenant_id;
      const { quote } = tenantId
        ? await buildQuote(items, tenantId)
        : { quote: order.quote || { price: { currency: 'INR', value: '0' }, breakup: [], ttl: 'P1D' } };
      const orderObj = buildOrderObject(context, body.message, 'Created', quote, tenant);

      await sendCallback(context.bap_uri, 'on_init', context, {
        order: {
          ...orderObj,
          fulfillments: (orderObj.fulfillments || []).map(f => ({ ...f, tracking: false })),
          payment: {
            ...order.payment,
            '@ondc/org/buyer_app_finder_fee_type':   'percent',
            '@ondc/org/buyer_app_finder_fee_amount': '3',
            '@ondc/org/settlement_basis':             'return_window_expiry',
            '@ondc/org/settlement_window':            'P1D',
            '@ondc/org/withholding_amount':           '10.00',
            '@ondc/org/settlement_details':           buildSettlementDetails(),
            type:   'ON-ORDER',
            status: 'NOT-PAID',
          },
          cancellation_terms: CANCELLATION_TERMS,
          tags: ORDER_TAGS,
        },
      }, tenant);
    } catch (err) {
      logger.error('handleInit processing failed:', err.message);
      if (context?.bap_uri) {
        await sendCallback(context.bap_uri, 'on_init', context, {
          error: { type: 'CORE-ERROR', code: '50000', message: err.message },
        }, tenant || envTenantFallback()).catch(() => {});
      }
    }
  });
};

const handleConfirm = async (req, res) => {
  const body    = req.body;
  // Deep-clone context so async callbacks always have full context even if req is GC'd
  const context = body.context ? JSON.parse(JSON.stringify(body.context)) : {};
  logger.info('ONDC /confirm received', { transaction_id: context?.transaction_id });

  await ack(res, context);

  setImmediate(async () => {
    let tenant = null;
    try {
      tenant = await resolveTenant(context?.bpp_id);
      if (!tenant?.id && !process.env.ONDC_SIGNING_PRIVATE_KEY) return;

      // Deep-clone order so async callbacks + cache always have full data even if req body is GC'd
      const order = body.message?.order ? JSON.parse(JSON.stringify(body.message.order)) : {};

      const vendor = tenant.id
        ? await fetchVendorForOrder(tenant.id, order.provider?.id).catch(() => null)
        : null;

      if (order.id) {
        confirmedOrderCache.set(order.id, { order, context, vendor, confirmTimestamp: null });
        lastConfirmedOrderId = order.id;
        logger.info('Cached confirmed order', { order_id: order.id, hasContext: !!context?.domain, hasBilling: !!order.billing });
      }

      // 1. Save to DB
      if (tenant.id) await saveONDCOrder(tenant.id, body, body);

      // 2. Push to CottKart
      try {
        const ckResult = await cottKartOrder.pushOrder(body);
        const cottKartOrderId = ckResult?.id || ckResult?.order_id;
        if (cottKartOrderId) {
          await pool.query(
            `UPDATE ondc_orders SET cottkart_order_id = ? WHERE ondc_order_id = ?`,
            [String(cottKartOrderId), order.id]
          );
        }
      } catch (ckErr) {
        logger.error('CottKart pushOrder failed (non-blocking):', ckErr.message);
      }

      // 3. Send on_confirm
      const now   = new Date().toISOString();
      const quote = tenant.id
        ? await buildQuote(order.items || [], tenant.id).then(r => r.quote).catch(() => order.quote)
        : order.quote;

      await sendCallback(context.bap_uri, 'on_confirm', context, {
        order: {
          id:         order.id,
          state:      'Created',
          provider:   order.provider,
          items:      order.items,
          billing:    order.billing,
          fulfillments: (order.fulfillments || [{ id: 'f1', type: 'Delivery' }]).map(f =>
            buildFulfillmentWithLocation(f, vendor, 'Pending', now)
          ),
          quote,
          payment: {
            ...order.payment,
            '@ondc/org/buyer_app_finder_fee_type':   'percent',
            '@ondc/org/buyer_app_finder_fee_amount': '3',
            '@ondc/org/settlement_basis':             'return_window_expiry',
            '@ondc/org/settlement_window':            'P1D',
            '@ondc/org/withholding_amount':           '10.00',
            '@ondc/org/settlement_details':           buildSettlementDetails(quote?.price?.value || order.payment?.['@ondc/org/settlement_details']?.[0]?.settlement_amount || '0.00'),
            status: order.payment?.type === 'ON-FULFILLMENT' ? 'NOT-PAID' : 'PAID',
          },
          cancellation_terms: CANCELLATION_TERMS,
          tags:       ORDER_TAGS,
          created_at: order.created_at || now,
          updated_at: order.updated_at || now,
        },
      }, tenant);

      // Save the confirm updated_at so on_update can reuse it (Pramaan expects match)
      const confirmUpdatedAt = order.updated_at || now;
      const cached = confirmedOrderCache.get(order.id);
      if (cached) cached.confirmTimestamp = confirmUpdatedAt;

      // Trigger On-Network Logistics search (Flow A1) — fire-and-forget
      ;(async () => {
        try {
          const lsDelay = ms => new Promise(r => setTimeout(r, ms));
          // Send Packed + Agent-assigned immediately (before LSP mock relay fires at ~5s)
          // Auto-status skips these for logistics orders (lsEntry exists in cache after startLogisticsFlow)
          const lsCtx1 = { ...context, message_id: uuidv4() };
          const packedPayload = buildStatusPayload(order.id, order, 'Packed', 'In-progress', vendor);
          await sendCallback(context.bap_uri, 'on_status', lsCtx1, { order: packedPayload }, tenant);
          const ce1 = confirmedOrderCache.get(order.id);
          if (ce1) ce1.currentFulfillmentState = 'Packed';
          logger.info('Logistics: Packed on_status sent', { order_id: order.id });
          await lsDelay(2000);

          const lsCtx2 = { ...context, message_id: uuidv4() };
          const agentPayload = buildStatusPayload(order.id, order, 'Agent-assigned', 'In-progress', vendor);
          await sendCallback(context.bap_uri, 'on_status', lsCtx2, { order: agentPayload }, tenant);
          const ce2 = confirmedOrderCache.get(order.id);
          if (ce2) ce2.currentFulfillmentState = 'Agent-assigned';
          logger.info('Logistics: Agent-assigned on_status sent', { order_id: order.id });
          await lsDelay(30000);  // Allow buyer cancellation window before triggering logistics

          if (cancelledOrders.has(order.id)) {
            logger.info('Logistics search skipped — order cancelled during window', { order_id: order.id });
            return;
          }
          const lsResult = await searchLogistics(order, context, tenant);
          await startLogisticsFlow(order, context, tenant, lsResult, vendor);
        } catch (e) {
          logger.warn('Logistics search failed (non-blocking):', e.message);
        }
      })();

      // Auto-trigger on_status sequence after on_confirm (for Pramaan certification)
      // Sends: Packed → Agent-assigned → Order-picked-up → Out-for-delivery → Order-delivered
      // with 2s delay between each. Flows that send /cancel (3B) will interrupt naturally.
      const autoStatusSequence = async () => {
        const delay = ms => new Promise(r => setTimeout(r, ms));
        const isCancelled = () => cancelledOrders.has(order.id);

        // Steps 1-4 fire rapidly (2s apart). Step 5 (Order-delivered) is delayed by 45s
        // to give Flow 3B/3C time to trigger cancel before Order-delivered fires.
        const steps = [
          { fulfillmentState: 'Packed',            orderState: 'In-progress', delayAfter: 2000  },
          { fulfillmentState: 'Agent-assigned',     orderState: 'In-progress', delayAfter: 2000  },
          { fulfillmentState: 'Order-picked-up',    orderState: 'In-progress', delayAfter: 2000  },
          { fulfillmentState: 'Out-for-delivery',   orderState: 'In-progress', delayAfter: 45000 },
          { fulfillmentState: 'Order-delivered',    orderState: 'Completed',   delayAfter: 2000  },
        ];

        // Wait 15s after on_confirm for Pramaan to process /status first
        await delay(15000);

        for (const step of steps) {
          if (isCancelled()) { logger.info('Auto on_status aborted (order cancelled)', { order_id: order.id }); return; }

          // Skip states already sent early by logistics block (Packed, Agent-assigned at T=0s)
          // Works for both retail and logistics orders.
          const DELIVERY_ORDER = ['Packed', 'Agent-assigned', 'Order-picked-up', 'Out-for-delivery', 'Order-delivered'];
          const currentEntry2 = confirmedOrderCache.get(order.id);
          const lastSentIdx = DELIVERY_ORDER.indexOf(currentEntry2?.currentFulfillmentState || '');
          const stepIdx = DELIVERY_ORDER.indexOf(step.fulfillmentState);
          if (stepIdx !== -1 && stepIdx <= lastSentIdx) {
            logger.info('Auto on_status: skipping already-sent state', { order_id: order.id, state: step.fulfillmentState });
            await delay(step.delayAfter);
            continue;
          }

          // For confirmed logistics orders: skip Order-picked-up, Out-for-delivery, Order-delivered
          // (LSP relay sends these — relay is no longer suppressed for Order-delivered per Flow A2 requirement)
          const lsEntry = logisticsOrderCache.get(order.id);
          if (lsEntry?.logisticsConfirmed && ['Order-picked-up', 'Out-for-delivery', 'Order-delivered'].includes(step.fulfillmentState)) {
            await delay(step.delayAfter);
            continue;
          }

          // Skip if this state was already sent proactively (e.g. by triggerMerchantReturnUpdate for Flow 4B)
          const currentEntry = confirmedOrderCache.get(order.id);
          if (step.fulfillmentState === 'Order-delivered' && currentEntry?.currentFulfillmentState === 'Order-delivered') {
            logger.info('Auto on_status skipping Order-delivered (already sent proactively)', { order_id: order.id });
            continue;
          }
          // Each proactive callback must have a unique message_id (Pramaan: "message_id should be unique for each call lifecycle")
          const stepContext = { ...context, message_id: uuidv4() };
          const payload = buildStatusPayload(order.id, order, step.fulfillmentState, step.orderState, vendor);
          await sendCallback(context.bap_uri, 'on_status', stepContext, { order: payload }, tenant);
          // Track current fulfillment state so handleCancel can decide ACK vs NACK
          const cacheEntry = confirmedOrderCache.get(order.id);
          if (cacheEntry) cacheEntry.currentFulfillmentState = step.fulfillmentState;
          logger.info('Auto on_status sent', { order_id: order.id, ...step });

          await delay(step.delayAfter);
        }
        logger.info('Auto on_status sequence complete', { order_id: order.id });

        // Return sequence (Flow 4A) is triggered by handleUpdate when Pramaan sends /update
      };
      autoStatusSequence().catch(err => logger.error('Auto on_status sequence failed:', err.message));

    } catch (err) {
      logger.error('handleConfirm processing failed:', err.message);
      if (context?.bap_uri) {
        await sendCallback(context.bap_uri, 'on_confirm', context, {
          error: { type: 'CORE-ERROR', code: '50000', message: err.message },
        }, tenant || envTenantFallback()).catch(() => {});
      }
    }
  });
};

const handleStatus = async (req, res) => {
  try {
    const body       = req.body;
    const context    = body.context;
    const ondcOrderId = body.message?.order_id;
    logger.info('ONDC /status received', { order_id: ondcOrderId });

    await ack(res, context);

    const tenant = await resolveTenant(context?.bpp_id);
    if (!tenant?.id && !process.env.ONDC_SIGNING_PRIVATE_KEY) return;

    try {
      const [rows] = tenant.id
        ? await pool.query(
            `SELECT * FROM ondc_orders WHERE ondc_order_id = ? AND tenant_id = ?`,
            [ondcOrderId, tenant.id]
          )
        : await pool.query(
            `SELECT * FROM ondc_orders WHERE ondc_order_id = ? LIMIT 1`,
            [ondcOrderId]
          );
      const dbOrder = rows[0] || null;
      let currentStatus = dbOrder?.status || 'Accepted';
      logger.info('handleStatus order lookup', { ondcOrderId, found: !!dbOrder, status: currentStatus });

      // If order was cancelled in-memory (triggerMerchantCancel), DB may lag — override immediately
      if (cancelledOrders.has(ondcOrderId)) {
        currentStatus = 'Cancelled';
      } else if (dbOrder?.cottkart_order_id) {
        try {
          const ckStatus = await cottKartOrder.fetchOrderStatus(dbOrder.cottkart_order_id);
          if (ckStatus?.status && ckStatus.status !== currentStatus) {
            currentStatus = ckStatus.status;
            await updateOrderStatus(ondcOrderId, currentStatus);
          }
        } catch (e) {
          logger.warn('CottKart status fetch failed:', e.message);
        }
      }

      // Build full order object — use cached confirm order if available
      const cachedEntry = confirmedOrderCache.get(ondcOrderId) || null;

      // For cancelled orders: use buildStatusPayload with last known fulfillment state
      // (handles RTO fulfillment structure correctly)
      if (currentStatus === 'Cancelled') {
        const lastState = cachedEntry?.currentFulfillmentState || 'Cancelled';
        // RTO states need special dual-fulfillment structure
        const isRtoState = ['RTO-Initiated', 'RTO-Delivered'].includes(lastState);
        const cancelFulfillmentState = isRtoState ? lastState : 'Cancelled';
        const statusPayload = buildStatusPayload(ondcOrderId, cachedEntry?.order || dbOrder, cancelFulfillmentState, 'Cancelled', cachedEntry?.vendor || null);
        await sendCallback(context.bap_uri, 'on_status', context, { order: statusPayload }, tenant);
        relayStatusToLogistics(ondcOrderId).catch(() => {});
        logger.info('handleStatus: cancelled order response', { ondcOrderId, lastState: cancelFulfillmentState });
        return;
      }

      // Map order state → valid ONDC fulfillment state code
      const fulfillmentStateMap = {
        'Created':     'Pending',
        'Accepted':    'Pending',
        'In-progress': 'Order-picked-up',
        'Completed':   'Order-delivered',
        'Cancelled':   'Cancelled',
      };
      const fulfillmentCode = fulfillmentStateMap[currentStatus] || 'Pending';
      const cachedOrder = cachedEntry?.order || null;
      const cachedVendor = cachedEntry?.vendor || null;
      const vendor = cachedVendor || (tenant.id
        ? await fetchVendorForOrder(tenant.id, cachedOrder?.provider?.id)
        : null);
      const now = new Date().toISOString();

      const baseFulfillments = cachedOrder?.fulfillments || [{ id: 'f1', type: 'Delivery' }];
      // Include return fulfillment if a return has been initiated (Flow 4A/4B)
      const returnFl = cachedEntry?.returnFulfillment || null;
      const deliveryFls = baseFulfillments.filter(f => f.type !== 'Return' && f.type !== 'Cancel').map(f =>
        buildFulfillmentWithLocation(f, vendor, fulfillmentCode, now)
      );
      const allFulfillments = returnFl ? [...deliveryFls, returnFl] : deliveryFls;
      const effectiveState = returnFl ? 'Completed' : currentStatus;

      const orderPayload = {
        id:       ondcOrderId,
        state:    effectiveState,
        provider: cachedOrder?.provider,
        items:    cachedOrder?.items,
        billing:  cachedOrder?.billing,
        fulfillments: allFulfillments,
        quote:     cachedOrder?.quote,
        payment: {
          ...(cachedOrder?.payment || {}),
          status: returnFl ? 'PAID' : (cachedOrder?.payment?.status || 'PAID'),
          '@ondc/org/settlement_details': buildSettlementDetails(),
        },
        tags:       ORDER_TAGS,
        created_at: cachedOrder?.created_at || now,
        updated_at: cachedOrder?.updated_at || now,
      };

      await sendCallback(context.bap_uri, 'on_status', context, {
        order: orderPayload,
      }, tenant);

      // Relay /status to logistics LSP (Flow A1) — fire-and-forget
      relayStatusToLogistics(ondcOrderId).catch(() => {});
    } catch (err) {
      logger.error('handleStatus processing failed:', err.message);
    }
  } catch (err) {
    logger.error('handleStatus failed:', err.message);
  }
};

const handleCancel = async (req, res) => {
  try {
    const body    = req.body;
    const context = body.context ? JSON.parse(JSON.stringify(body.context)) : {};
    const { order_id, cancellation_reason_id } = body.message || {};
    logger.info('ONDC /cancel received', { order_id });

    // Flow 7 (Non Cancellable): NACK if order already delivered/cancelled.
    // Flow 2 (Buyer Cancel): ACK if order is still in-progress and can be cancelled.
    const cachedEntry = confirmedOrderCache.get(order_id);
    const currentState = cachedEntry?.currentFulfillmentState || '';
    const NON_CANCELLABLE = new Set(['Order-delivered', 'Cancelled', 'RTO-Initiated', 'RTO-Delivered']);
    if (NON_CANCELLABLE.has(currentState)) {
      logger.info('ONDC /cancel NACK — order not cancellable in current state', { order_id, currentState });
      return nack(res, context, 'Order cannot be cancelled');
    }
    cancelledOrders.add(order_id);  // Stop auto-status sequence
    await ack(res, context);

    const tenant = await resolveTenant(context?.bpp_id);
    if (!tenant) return;

    try {
      const [rows] = await pool.query(
        `SELECT * FROM ondc_orders WHERE ondc_order_id = ? AND tenant_id = ?`,
        [order_id, tenant.id]
      );
      const dbOrder = rows[0] || null;

      if (dbOrder?.cottkart_order_id) {
        try {
          await cottKartOrder.cancelOrder(dbOrder.cottkart_order_id, cancellation_reason_id);
        } catch (e) {
          logger.warn('CottKart cancel failed:', e.message);
        }
      }

      if (dbOrder) {
        await pool.query(
          `UPDATE ondc_orders SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
           WHERE ondc_order_id = ?`,
          [order_id]
        );
      }

      // Mark cache as Cancelled so any subsequent /cancel gets NACK
      if (cachedEntry) cachedEntry.currentFulfillmentState = 'Cancelled';
      const cachedOrder = cachedEntry?.order || null;
      const cachedVendor = cachedEntry?.vendor || null;
      // updated_at must be >= on_cancel context.timestamp (sendCallback sets it slightly after now)
      // Also must be >= /cancel request context.timestamp (Pramaan cancelDate check)
      const cancelTime = context?.timestamp ? new Date(context.timestamp).getTime() : 0;
      const now = new Date(Math.max(Date.now() + 1, cancelTime + 1)).toISOString();

      const cancelFulfillmentTags = [{ code: 'cancellation_terms', list: [{ code: 'reason_required', value: 'false' }] }];

      const cancelPayload = cachedOrder ? {
        id:    order_id,
        state: 'Cancelled',
        provider:  cachedOrder.provider,
        items:     cachedOrder.items,
        billing:   cachedOrder.billing,
        quote:     cachedOrder.quote,
        payment: {
          ...(cachedOrder.payment || {}),
          '@ondc/org/buyer_app_finder_fee_type':   'percent',
          '@ondc/org/buyer_app_finder_fee_amount': '3',
          '@ondc/org/settlement_basis':             'return_window_expiry',
          '@ondc/org/settlement_window':            'P1D',
          '@ondc/org/withholding_amount':           '10.00',
          '@ondc/org/settlement_details':           buildSettlementDetails(),
          status: 'PAID',
        },
        cancellation: {
          cancelled_by: 'CONSUMER',
          reason: { id: cancellation_reason_id || '001' },
        },
        fulfillments: (cachedOrder.fulfillments || []).map(f => ({
          ...buildFulfillmentWithLocation(f, cachedVendor, 'Cancelled', now),
          tags: cancelFulfillmentTags,
        })),
        created_at:  cachedOrder.created_at || now,
        updated_at:  now,
      } : {
        id:    order_id,
        state: 'Cancelled',
        cancellation: {
          cancelled_by: 'CONSUMER',
          reason: { id: cancellation_reason_id || '001' },
        },
        fulfillments: [{ id: 'f1', state: { descriptor: { code: 'Cancelled' } }, tags: cancelFulfillmentTags }],
        updated_at: now,
      };

      await sendCallback(context.bap_uri, 'on_cancel', context, {
        order: cancelPayload,
      }, tenant);
    } catch (err) {
      logger.error('handleCancel processing failed:', err.message);
    }
  } catch (err) {
    logger.error('handleCancel failed:', err.message);
  }
};

// handleUpdate — receives /update from BAP (settlement update, return requests, etc.)
// Flow 3A (settlement): update_target = 'payment' → ACK only
// Flow 4A/4B (return):  update_target = 'fulfillment' → ACK + on_update (Return_Initiated → Approved → Picked → Delivered)
const handleUpdate = async (req, res) => {
  const body          = req.body;
  const context       = body.context ? JSON.parse(JSON.stringify(body.context)) : {};
  const order         = body.message?.order ? JSON.parse(JSON.stringify(body.message.order)) : {};
  const update_target = body.message?.update_target || '';
  logger.info('ONDC /update received', {
    transaction_id: context?.transaction_id,
    order_id: order.id,
    update_target,
    bap_uri: context?.bap_uri,
  });

  await ack(res, context);

  // For any update_target — resolve order from cache and send appropriate on_update
  if (update_target) {
    (async () => {
      try {
        const tenant = await resolveTenant(context?.bpp_id);
        const cachedEntry = confirmedOrderCache.get(order.id);
        if (!cachedEntry) {
          logger.warn(`handleUpdate ${update_target}: order not in cache`, { order_id: order.id });
          return;
        }
        const { order: confirmedOrder, context: confirmedContext, vendor: cachedVendor, confirmTimestamp } = cachedEntry;
        const fullContext = { ...confirmedContext, ...context };
        const fullOrder = {
          ...confirmedOrder,
          ...order,
          provider: order.provider || confirmedOrder.provider,
          items:    order.items    || confirmedOrder.items,
          billing:  order.billing  || confirmedOrder.billing,
          quote:    order.quote    || confirmedOrder.quote,
          payment:  order.payment  || confirmedOrder.payment,
        };

        let vendor = cachedVendor;
        if (!vendor && tenant?.id) {
          vendor = await fetchVendorForOrder(tenant.id, (order.provider?.id || confirmedOrder.provider?.id)).catch(() => null);
        }

        const now = new Date().toISOString();
        const providerName = vendor?.business_name || fullOrder.provider?.descriptor?.name || '';

        // Extract Return fulfillments from BAP's /update request
        const bapReturnFulfillments = (order.fulfillments || []).filter(f => f.type === 'Return');

        // Build return fulfillment for on_update, using BAP's return request details
        const buildReturnFulfillment = (returnState, bapReturnFl) => {
          const returnId = bapReturnFl?.id
            || bapReturnFl?.tags?.[0]?.list?.find(t => t.code === 'id')?.value
            || 'r1';
          // Preserve BAP's return_request tags and add initiated_by
          let tags = bapReturnFl?.tags || [];
          if (tags.length > 0) {
            const tagList = [...(tags[0].list || [])];
            if (!tagList.find(t => t.code === 'initiated_by')) {
              tagList.push({ code: 'initiated_by', value: context?.bap_id || fullContext?.bap_id || '' });
            }
            tags = [{ ...tags[0], list: tagList }];
          } else {
            tags = [{
              code: 'return_request',
              list: [
                { code: 'id', value: returnId },
                { code: 'item_id', value: (fullOrder.items?.[0]?.id || '') },
                { code: 'parent_item_id', value: (fullOrder.items?.[0]?.parent_item_id || fullOrder.items?.[0]?.id || 'N/A') },
                { code: 'item_quantity', value: String(fullOrder.items?.[0]?.quantity?.count || 1) },
                { code: 'reason_id', value: '001' },
                { code: 'reason_desc', value: 'detailed description for return' },
                { code: 'images', value: 'https://ondc.cottkart.com/placeholder.png' },
                { code: 'ttl_approval', value: 'PT24H' },
                { code: 'ttl_reverseqc', value: 'P3D' },
                { code: 'initiated_by', value: context?.bap_id || fullContext?.bap_id || '' },
              ],
            }];
          }
          return {
            id: returnId,
            type: 'Return',
            state: { descriptor: { code: returnState } },
            '@ondc/org/provider_name': providerName,
            tags,
          };
        };

        const buildReturnPayload = (returnState, bapReturnFl) => {
          const deliveryFulfillments = (confirmedOrder.fulfillments || [{ id: 'f1', type: 'Delivery' }]).map(f =>
            buildFulfillmentWithLocation(f, vendor, 'Order-delivered', now)
          );
          return {
            id:       fullOrder.id,
            state:    'Completed',
            provider: fullOrder.provider,
            items:    fullOrder.items,
            billing:  fullOrder.billing,
            fulfillments: [...deliveryFulfillments, buildReturnFulfillment(returnState, bapReturnFl)],
            quote:    fullOrder.quote,
            payment:  { ...(fullOrder.payment || {}), status: 'PAID' },
            tags:     ORDER_TAGS,
            created_at: fullOrder.created_at || now,
            updated_at: confirmTimestamp || fullOrder.updated_at || now,
          };
        };

        // payment = Flow 3A settlement OR Flow 4A refund response; fulfillment/item = Flow 4A/4B return sequence
        if (update_target === 'payment') {
          // Determine which return sequence to send based on last return state
          // Flow 4A:           last=Return_Delivered → resend Return_Approved+Picked+Delivered
          // Flow 4B instance1: last=Return_Rejected  → send Return_Approved+Picked+Delivered
          // Flow 4B instance2: last=Return_Picked    → send Return_Delivered ONLY (no re-send)
          // Flow 3A:           no returnFulfillment  → ACK only
          const paymentReturnFl = cachedEntry.returnFulfillment;
          const lastReturnState = paymentReturnFl?.state?.descriptor?.code;

          const buildPaymentReturnPayload = (returnState) => {
            const returnFl = { ...paymentReturnFl, state: { descriptor: { code: returnState } } };
            const nowR = new Date().toISOString();
            const deliveryFls = (confirmedOrder.fulfillments || [{ id: 'f1', type: 'Delivery' }])
              .filter(f => f.type !== 'Return' && f.type !== 'Cancel')
              .map(f => buildFulfillmentWithLocation(f, vendor, 'Order-delivered', nowR));
            return {
              id:       fullOrder.id,
              state:    'Completed',
              provider: fullOrder.provider,
              items:    fullOrder.items,
              billing:  fullOrder.billing,
              fulfillments: [...deliveryFls, returnFl],
              quote:    fullOrder.quote,
              payment:  { ...(fullOrder.payment || {}), status: 'PAID' },
              tags:     ORDER_TAGS,
              created_at: fullOrder.created_at || new Date().toISOString(),
              updated_at: confirmTimestamp || fullOrder.updated_at || new Date().toISOString(),
            };
          };

          if (paymentReturnFl && (lastReturnState === 'Return_Rejected' || lastReturnState === 'Return_Delivered')) {
            // Flow 4B instance1 (rejected) or Flow 4A: send Return_Approved → Picked → Delivered
            logger.info(`handleUpdate payment: sending full return sequence (last=${lastReturnState})`, { order_id: order.id });
            const delay = ms => new Promise(r => setTimeout(r, ms));
            for (const returnState of ['Return_Approved', 'Return_Picked', 'Return_Delivered']) {
              const msgId = uuidv4();
              await sendCallback(fullContext.bap_uri, 'on_update', { ...fullContext, message_id: msgId }, { order: buildPaymentReturnPayload(returnState) }, tenant);
              logger.info('on_update (payment return seq) sent', { order_id: order.id, returnState });
              cachedEntry.returnFulfillment = { ...paymentReturnFl, state: { descriptor: { code: returnState } } };
              await delay(2000);
            }
          } else if (paymentReturnFl && ['Return_Initiated', 'Return_Approved', 'Return_Picked'].includes(lastReturnState)) {
            // Flow 4B instance2 (approved path): send Return_Delivered ONLY after /update(payment)
            // If /update(payment) arrived early (before Return_Picked stored), await auto-send loop first
            logger.info(`handleUpdate payment: Return_Delivered (Flow 4B approved path, last=${lastReturnState})`, { order_id: order.id });
            if (cachedEntry.returnSequencePromise) {
              await cachedEntry.returnSequencePromise;
            }
            const currentReturnFl = cachedEntry.returnFulfillment || paymentReturnFl;
            const msgId = uuidv4();
            await sendCallback(fullContext.bap_uri, 'on_update', { ...fullContext, message_id: msgId }, { order: buildPaymentReturnPayload('Return_Delivered') }, tenant);
            logger.info('on_update (Return_Delivered) sent', { order_id: order.id });
            cachedEntry.returnFulfillment = { ...currentReturnFl, state: { descriptor: { code: 'Return_Delivered' } } };
          } else {
            logger.info('handleUpdate payment: ACK only (Flow 3A settlement or no pending return)', { order_id: order.id });
          }

        } else if (update_target === 'fulfillment' || update_target === 'item') {
          // Return request from BAP — two paths:
          //   Rejection (Flow 4B inst1): pendingReturnRejection flag set → send Return_Initiated → Return_Rejected
          //   Approval  (Flow 4B inst2): no flag → send Return_Initiated, then auto Return_Approved → Return_Picked
          const bapReturnFl = bapReturnFulfillments[0] || null;
          const cached = confirmedOrderCache.get(fullOrder.id);

          if (cached?.pendingReturnRejection) {
            // Flow 4B instance1 — BAP requested return, BPP rejects it
            cached.pendingReturnRejection = false;
            cached.returnFulfillment = buildReturnFulfillment('Return_Initiated', bapReturnFl);
            cached.returnContext = { ...fullContext };

            const initiatedPayload = buildReturnPayload('Return_Initiated', bapReturnFl);
            await sendCallback(fullContext.bap_uri, 'on_update', fullContext, { order: initiatedPayload }, tenant);
            logger.info('on_update (Return_Initiated) sent for rejection flow', { order_id: fullOrder.id });

            await new Promise(r => setTimeout(r, 2000));

            const rejectedPayload = buildReturnPayload('Return_Rejected', bapReturnFl);
            const rejMsgId = uuidv4();
            await sendCallback(fullContext.bap_uri, 'on_update', { ...fullContext, message_id: rejMsgId }, { order: rejectedPayload }, tenant);
            logger.info('on_update (Return_Rejected) sent', { order_id: fullOrder.id });
            if (cached) cached.returnFulfillment = { ...cached.returnFulfillment, state: { descriptor: { code: 'Return_Rejected' } } };

          } else {
            // Flow 4B instance2 (approved path): Return_Initiated, then auto Return_Approved → Return_Picked
            // Return_Delivered will be sent when BAP sends /update(payment)
            if (cached) {
              cached.returnFulfillment = buildReturnFulfillment('Return_Initiated', bapReturnFl);
              cached.returnContext = { ...fullContext };
            }

            const payload = buildReturnPayload('Return_Initiated', bapReturnFl);
            await sendCallback(fullContext.bap_uri, 'on_update', fullContext, { order: payload }, tenant);
            logger.info('on_update (Return_Initiated) sent OK', { order_id: fullOrder.id });

            // Store the Promise so payment handler can await it if /update(payment) arrives early
            const autoSendPromise = (async () => {
              const delay = ms => new Promise(r => setTimeout(r, ms));
              const cachedRef = confirmedOrderCache.get(fullOrder.id);
              for (const returnState of ['Return_Approved', 'Return_Picked']) {
                await delay(2000);
                const statePayload = buildReturnPayload(returnState, bapReturnFl);
                const msgId = uuidv4();
                await sendCallback(fullContext.bap_uri, 'on_update', { ...fullContext, message_id: msgId }, { order: statePayload }, tenant);
                logger.info(`on_update (${returnState}) auto-sent after fulfillment update`, { order_id: fullOrder.id });
                if (cachedRef?.returnFulfillment) {
                  cachedRef.returnFulfillment = { ...cachedRef.returnFulfillment, state: { descriptor: { code: returnState } } };
                }
              }
            })();
            if (cached) cached.returnSequencePromise = autoSendPromise;
          }
        }

        logger.info('handleUpdate complete', { order_id: fullOrder.id, update_target });
      } catch (err) {
        logger.error('handleUpdate callback FAILED:', err.message, err.stack);
      }
    })();
  }
};

// triggerMerchantUpdate — internal endpoint to initiate merchant-side on_update
// Used for Flow 3A (Partial Cancellation) testing
const triggerMerchantUpdate = async (req, res) => {
  try {
    const rawId = req.params.order_id;
    const order_id = rawId === 'latest' ? lastConfirmedOrderId : rawId;
    if (!order_id) return res.status(404).json({ error: 'No confirmed order in cache' });
    const cachedEntry = confirmedOrderCache.get(order_id);
    if (!cachedEntry) {
      return res.status(404).json({ error: 'Order not found in cache' });
    }
    const { order, context, confirmTimestamp } = cachedEntry;
    const tenant = await resolveTenant(context?.bpp_id);
    const vendor = cachedEntry.vendor || (tenant?.id
      ? await fetchVendorForOrder(tenant.id, order.provider?.id).catch(() => null)
      : null);

    await sendPartialCancelOnUpdate(context, order, vendor, tenant, confirmTimestamp);
    logger.info('Merchant on_update (Cancelled) sent via trigger', { order_id });
    res.json({ success: true, message: 'on_update sent', order_id });
  } catch (err) {
    logger.error('triggerMerchantUpdate failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// triggerMerchantReturnUpdate — sends unsolicited on_update for return flow states
// Flow 4A (seller-approved return): Return_Approved → Return_Picked → Return_Delivered
// Flow 4B (seller-rejected return): Return_Rejected
// Body: { state: 'Return_Approved' | 'Return_Picked' | 'Return_Delivered' | 'Return_Rejected' }
// Or:   { type: '4a' }  → sends full Return_Approved + Return_Picked + Return_Delivered sequence
// Or:   { type: '4b' }  → sends Return_Rejected
const triggerMerchantReturnUpdate = async (req, res) => {
  try {
    const rawId = req.params.order_id;
    const order_id = rawId === 'latest' ? lastConfirmedOrderId : rawId;
    if (!order_id) return res.status(404).json({ error: 'No confirmed order in cache' });

    const cachedEntry = confirmedOrderCache.get(order_id);
    if (!cachedEntry) return res.status(404).json({ error: 'Order not found in cache' });

    const { order, context, vendor: cachedVendor, confirmTimestamp } = cachedEntry;
    const tenant = await resolveTenant(context?.bpp_id);
    const vendor = cachedVendor || (tenant?.id
      ? await fetchVendorForOrder(tenant.id, order.provider?.id).catch(() => null)
      : null);

    const type  = req.body?.type;
    const state = req.body?.state;

    // Determine the sequence of states to send
    let steps;
    if (type === '4a') {
      steps = ['Return_Approved', 'Return_Picked', 'Return_Delivered'];
    } else if (type === '4b') {
      // Flow 4B instance1 (rejected path): set a flag so the NEXT BAP /update(item) is rejected
      // (rejection must happen IN RESPONSE to BAP's /update(item), not proactively)
      cachedEntry.pendingReturnRejection = true;
      logger.info('Flow 4B: rejection flag set — next BAP /update(item) will send Return_Initiated→Return_Rejected', { order_id });
      res.json({ success: true, message: 'Flow 4B rejection flag set — run Pramaan Flow 4B session now', order_id });
      // Still ensure Order-delivered is sent if not yet (needed before return request)
      if (cachedEntry.currentFulfillmentState !== 'Order-delivered') {
        try {
          const deliveredPayload = buildStatusPayload(order_id, order, 'Order-delivered', 'Completed', vendor);
          await sendCallback(context.bap_uri, 'on_status', { ...context, message_id: uuidv4() }, { order: deliveredPayload }, tenant);
          if (cachedEntry) cachedEntry.currentFulfillmentState = 'Order-delivered';
          logger.info('on_status (Order-delivered) sent before Flow 4B rejection session', { order_id });
        } catch (e) {
          logger.warn('Failed to send Order-delivered before Flow 4B rejection session:', e.message);
        }
      }
      return;
    } else if (state) {
      steps = [state];
    } else {
      return res.status(400).json({ error: 'Provide type (4a/4b) or state in body' });
    }

    // Respond immediately, send callbacks in background
    res.json({ success: true, message: `on_update return sequence started`, steps, order_id });

    // For type 4b (legacy path only — now uses flag approach above)
    if (type === '4b' && cachedEntry.currentFulfillmentState !== 'Order-delivered') {
      try {
        const deliveredPayload = buildStatusPayload(order_id, order, 'Order-delivered', 'Completed', vendor);
        await sendCallback(context.bap_uri, 'on_status', { ...context, message_id: uuidv4() }, { order: deliveredPayload }, tenant);
        if (cachedEntry) cachedEntry.currentFulfillmentState = 'Order-delivered';
        logger.info('on_status (Order-delivered) sent before return sequence', { order_id });
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        logger.warn('Failed to send Order-delivered before return sequence:', e.message);
      }
    }

    const providerName = vendor?.business_name || order.provider?.descriptor?.name || '';

    // Get stored return fulfillment from cache (saved by handleUpdate when BAP sent /update)
    const storedReturnFl = cachedEntry.returnFulfillment;
    const returnContext = cachedEntry.returnContext || context;

    // Build base return fulfillment once (state is set per iteration below)
    const baseReturnFl = storedReturnFl || {
      id: 'r1',
      type: 'Return',
      '@ondc/org/provider_name': providerName,
      tags: [{
        code: 'return_request',
        list: [
          { code: 'id',           value: 'r1' },
          { code: 'item_id',      value: (order.items?.[0]?.id || '') },
          { code: 'item_quantity',value: String(order.items?.[0]?.quantity?.count || 1) },
          { code: 'reason_id',    value: '001' },
          { code: 'reason_desc',  value: 'detailed description for return' },
          { code: 'images',       value: 'https://ondc.cottkart.com/placeholder.png' },
          { code: 'ttl_approval', value: 'PT24H' },
          { code: 'ttl_reverseqc',value: 'P3D' },
          { code: 'initiated_by', value: returnContext?.bap_id || '' },
        ],
      }],
    };

    // Save to cache so handleUpdate(payment) can reference it for the refund response sequence
    if (!storedReturnFl && cachedEntry) {
      cachedEntry.returnFulfillment = baseReturnFl;
      cachedEntry.returnContext = cachedEntry.returnContext || context;
    }

    // Delivery fulfillments from confirmed order
    const deliveryFulfillments = (order.fulfillments || []).filter(f => f.type !== 'Return' && f.type !== 'Cancel');

    const delay = ms => new Promise(r => setTimeout(r, ms));
    for (const returnState of steps) {
      const now = new Date().toISOString();

      const returnFl = { ...baseReturnFl, state: { descriptor: { code: returnState } } };

      const returnPayload = {
        id:    order_id,
        state: 'Completed',
        provider:  order.provider,
        items:     order.items,
        billing:   order.billing,
        quote:     order.quote,
        payment:   { ...(order.payment || {}), status: 'PAID' },
        fulfillments: [
          ...(deliveryFulfillments.length > 0
            ? deliveryFulfillments
            : [{ id: 'f1', type: 'Delivery' }]
          ).map(f => buildFulfillmentWithLocation(f, vendor, 'Order-delivered', now)),
          returnFl,
        ],
        tags: ORDER_TAGS,
        created_at: order.created_at || now,
        updated_at: confirmTimestamp || order.updated_at || now,
      };

      // Push N.O. log before HTTP callback
      const cbMsgId = uuidv4();
      const onUpdatePayload = {
        context: {
          ...returnContext,
          action: 'on_update',
          bpp_id:  process.env.ONDC_SUBSCRIBER_ID || returnContext.bpp_id,
          bpp_uri: process.env.ONDC_SUBSCRIBER_URL || returnContext.bpp_uri,
          timestamp: now,
          message_id: cbMsgId,
          ttl: 'PT30S',
        },
        message: { order: returnPayload },
      };
      pushTxnLog('on_update', onUpdatePayload).catch(e =>
        logger.warn(`N.O. on_update push failed for ${returnState}:`, e.message)
      );

      try {
        await sendCallback(returnContext.bap_uri, 'on_update', { ...returnContext, message_id: cbMsgId }, { order: returnPayload }, tenant);
        logger.info('on_update (return state) sent', { order_id, returnState });
        // Update cached return fulfillment state for /status responses
        if (cachedEntry?.returnFulfillment) {
          cachedEntry.returnFulfillment = { ...cachedEntry.returnFulfillment, state: { descriptor: { code: returnState } } };
        }
      } catch (cbErr) {
        logger.error(`on_update (${returnState}) HTTP callback failed:`, cbErr.message);
      }
      await delay(2000);
    }
    logger.info('on_update return sequence complete', { order_id, steps });
  } catch (err) {
    logger.error('triggerMerchantReturnUpdate failed:', err.message);
  }
};

// Build RTO fulfillment object (type "RTO") for Flow 3B
const buildRtoFulfillment = (rtoState, reasonId) => {
  const subscriberId = process.env.ONDC_SUBSCRIBER_ID || 'ondc.cottkart.com';
  return {
    id:   'rto1',
    type: 'RTO',
    state: { descriptor: { code: rtoState } },
    tags: [{
      code: 'rto_event',
      list: [
        { code: 'retry_count',            value: '0' },
        { code: 'rto_id',                 value: 'rto1' },
        { code: 'cancellation_reason_id', value: reasonId || '011' },
        { code: 'cancelled_by',           value: subscriberId },
        { code: 'sub_reason_id',          value: '' },
      ],
    }],
  };
};

// triggerMerchantCancel — internal endpoint to initiate merchant-side on_cancel
// Used for Flow 3B/3C testing
const triggerMerchantCancel = async (req, res) => {
  try {
    const rawId = req.params.order_id;
    const order_id = rawId === 'latest' ? lastConfirmedOrderId : rawId;
    if (!order_id) return res.status(404).json({ error: 'No confirmed order in cache' });
    const { reason_id = '011', rto = false } = req.body || {};
    const cachedEntry = confirmedOrderCache.get(order_id);
    if (!cachedEntry) {
      return res.status(404).json({ error: 'Order not found in cache' });
    }
    const { order, context, vendor: cachedVendor } = cachedEntry;
    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // Signal auto-sequence to stop for this order (same as handleCancel)
    cancelledOrders.add(order_id);
    // Persist Cancelled to DB so handleStatus returns correct state after server restart
    updateOrderStatus(order_id, 'Cancelled').catch(e => logger.warn('DB cancel update failed (non-blocking):', e.message));
    // For Flow A2 (logistics RTO): suppress logistics Order-delivered relay + cancel LSP order
    markRetailOrderCancelled(order_id);
    cancelLogisticsOrder(order_id).catch(e => logger.warn("Logistics cancel failed (non-blocking):", e.message));

    const now = new Date().toISOString();
    const subscriberId = process.env.ONDC_SUBSCRIBER_ID || 'ondc.cottkart.com';
    const cancelFulfillmentTags = [{ code: 'cancellation_terms', list: [{ code: 'reason_required', value: 'false' }] }];

    // For RTO: Delivery fulfillment keeps Out-for-delivery + RTO fulfillment (RTO-Initiated)
    // For non-RTO (3C): single Delivery fulfillment with state Cancelled
    const deliveryFulfillments = (order.fulfillments || []).map(f => ({
      ...buildFulfillmentWithLocation(f, cachedVendor, rto ? 'Out-for-delivery' : 'Cancelled', now),
      tags: cancelFulfillmentTags,
    }));

    const fulfillments = rto
      ? [...deliveryFulfillments, buildRtoFulfillment('RTO-Initiated', reason_id)]
      : deliveryFulfillments;

    const cancelPayload = {
      id:    order_id,
      state: 'Cancelled',
      provider:  order.provider,
      items:     order.items,
      billing:   order.billing,
      quote:     order.quote,
      payment: {
        ...(order.payment || {}),
        '@ondc/org/buyer_app_finder_fee_type':   'percent',
        '@ondc/org/buyer_app_finder_fee_amount': '3',
        '@ondc/org/settlement_basis':             'return_window_expiry',
        '@ondc/org/settlement_window':            'P1D',
        '@ondc/org/withholding_amount':           '10.00',
        '@ondc/org/settlement_details':           buildSettlementDetails(),
        status: 'PAID',
      },
      cancellation: {
        cancelled_by: rto ? subscriberId : (context?.bap_id || 'SELLER'),
        reason: { id: reason_id },
      },
      fulfillments,
      tags: ORDER_TAGS,
      created_at:  order.created_at || now,
      // Ensure updated_at >= context.timestamp (sendCallback sets timestamp slightly after)
      updated_at:  new Date(Date.now() + 1).toISOString(),
    };

    await sendCallback(context.bap_uri, 'on_cancel', { ...context, message_id: uuidv4() }, { order: cancelPayload }, tenant);
    logger.info('Merchant on_cancel sent', { order_id, reason_id, rto });
    res.json({ success: true, message: 'on_cancel sent', order_id });

    // For RTO flows: auto-send on_status RTO-Initiated → RTO-Delivered after on_cancel
    // (avoids need for manual trigger/merchant-status-sequence a2 call)
    if (rto) {
      const rtoDelay = ms => new Promise(r => setTimeout(r, ms));
      setImmediate(async () => {
        try {
          await rtoDelay(1000);
          const rtoInitPayload = buildStatusPayload(order_id, order, 'RTO-Initiated', 'Cancelled', cachedVendor);
          await sendCallback(context.bap_uri, 'on_status', { ...context, message_id: uuidv4() }, { order: rtoInitPayload }, tenant);
          const e1 = confirmedOrderCache.get(order_id);
          if (e1) e1.currentFulfillmentState = 'RTO-Initiated';
          logger.info('Auto RTO-Initiated on_status sent', { order_id });

          await rtoDelay(2000);
          const rtoDelvPayload = buildStatusPayload(order_id, order, 'RTO-Delivered', 'Cancelled', cachedVendor);
          await sendCallback(context.bap_uri, 'on_status', { ...context, message_id: uuidv4() }, { order: rtoDelvPayload }, tenant);
          const e2 = confirmedOrderCache.get(order_id);
          if (e2) e2.currentFulfillmentState = 'RTO-Delivered';
          logger.info('Auto RTO-Delivered on_status sent', { order_id });
        } catch (e) {
          logger.warn('Auto RTO on_status failed (non-blocking):', e.message);
        }
      });
    }
  } catch (err) {
    logger.error('triggerMerchantCancel failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// triggerMerchantStatus — proactively send a single on_status
// Body: { state: 'Packed', order_state: 'Accepted' } (defaults to Pending/Accepted)
const triggerMerchantStatus = async (req, res) => {
  try {
    const rawId = req.params.order_id;
    const order_id = rawId === 'latest' ? lastConfirmedOrderId : rawId;
    if (!order_id) return res.status(404).json({ error: 'No confirmed order in cache' });

    const cachedEntry = confirmedOrderCache.get(order_id);
    if (!cachedEntry) return res.status(404).json({ error: 'Order not found in cache' });

    const { order, context, vendor: cachedVendor } = cachedEntry;
    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const vendor = cachedVendor || await fetchVendorForOrder(tenant?.id, order.provider?.id).catch(() => null);

    // Map shorthand status param to fulfillment/order state pairs
    const STATUS_MAP = {
      pending:          { fulfillmentState: 'Pending',          orderState: 'Accepted' },
      packed:           { fulfillmentState: 'Packed',           orderState: 'In-progress' },
      shipped:          { fulfillmentState: 'Order-picked-up',  orderState: 'In-progress' },
      out_for_delivery: { fulfillmentState: 'Out-for-delivery', orderState: 'In-progress' },
      delivered:        { fulfillmentState: 'Order-delivered',   orderState: 'Completed' },
      cancelled:        { fulfillmentState: 'Cancelled',        orderState: 'Cancelled' },
    };
    const mapped = STATUS_MAP[req.body?.status];
    const fulfillmentState = mapped?.fulfillmentState || req.body?.state || 'Pending';
    const orderState       = mapped?.orderState       || req.body?.order_state || 'Accepted';

    const statusPayload = buildStatusPayload(order_id, order, fulfillmentState, orderState, vendor);

    await sendCallback(context.bap_uri, 'on_status', { ...context, message_id: uuidv4() }, { order: statusPayload }, tenant);
    logger.info('Proactive on_status sent', { order_id, fulfillmentState, orderState });
    res.json({ success: true, message: 'on_status sent', order_id, state: fulfillmentState });
  } catch (err) {
    logger.error('triggerMerchantStatus failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// Helper: build an on_status payload for a given fulfillment state + order state
const buildStatusPayload = (order_id, order, fulfillmentState, orderState, vendor) => {
  const now = new Date().toISOString();
  // RTO states: Delivery stays at Out-for-delivery + separate RTO fulfillment
  const isRto = fulfillmentState === 'RTO-Delivered' || fulfillmentState === 'RTO-Initiated';

  const deliveryFulfillments = (order.fulfillments || [{ id: 'f1', type: 'Delivery' }]).map(f =>
    buildFulfillmentWithLocation(f, vendor, isRto ? 'Out-for-delivery' : fulfillmentState, now)
  );
  const fulfillments = isRto
    ? [...deliveryFulfillments, buildRtoFulfillment(fulfillmentState, '011')]
    : deliveryFulfillments;

  return {
    id:       order_id,
    state:    orderState,
    provider: order.provider,
    items:    order.items,
    billing:  order.billing,
    fulfillments,
    quote:     order.quote,
    payment: {
      ...order.payment,
      '@ondc/org/settlement_details': buildSettlementDetails(),
      status: (order.payment?.type === 'ON-FULFILLMENT')
        ? (fulfillmentState === 'Order-delivered' || orderState === 'Completed' ? 'PAID' : 'NOT-PAID')
        : 'PAID',
    },
    tags:       ORDER_TAGS,
    created_at: order.created_at || now,
    updated_at: order.updated_at || now,
  };
};

// triggerMerchantStatusSequence — sends sequential on_status calls
// Body: { type: '3a' } (default, full delivery: 5 states)
//       { type: '3b' } (pre-RTO: 4 states, stops at Out-for-delivery)
//       { type: 'rto_delivered' } (single RTO-Delivered + Cancelled, for after on_cancel RTO)
const triggerMerchantStatusSequence = async (req, res) => {
  try {
    const rawId = req.params.order_id;
    const order_id = rawId === 'latest' ? lastConfirmedOrderId : rawId;
    if (!order_id) return res.status(404).json({ error: 'No confirmed order in cache' });

    const cachedEntry = confirmedOrderCache.get(order_id);
    if (!cachedEntry) return res.status(404).json({ error: 'Order not found in cache' });

    const { order, context, vendor: cachedVendor } = cachedEntry;
    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const vendor = cachedVendor || await fetchVendorForOrder(tenant.id, order.provider?.id);
    const type = req.body?.type || '3a';

    // Define sequences per flow type
    // Per Pramaan PDF: order state must be "In-progress" for transit states, "Completed" for delivered
    const sequences = {
      '3a': [
        { fulfillmentState: 'Packed',           orderState: 'In-progress' },
        { fulfillmentState: 'Agent-assigned',    orderState: 'In-progress' },
        { fulfillmentState: 'Order-picked-up',   orderState: 'In-progress' },
        { fulfillmentState: 'Out-for-delivery',  orderState: 'In-progress' },
        { fulfillmentState: 'Order-delivered',   orderState: 'Completed' },
      ],
      '3b': [
        { fulfillmentState: 'Packed',           orderState: 'In-progress' },
        { fulfillmentState: 'Agent-assigned',   orderState: 'In-progress' },
        { fulfillmentState: 'Order-picked-up',  orderState: 'In-progress' },
        { fulfillmentState: 'Out-for-delivery', orderState: 'In-progress' },
      ],
      'rto_initiated': [
        { fulfillmentState: 'RTO-Initiated', orderState: 'Cancelled' },
      ],
      'rto_delivered': [
        { fulfillmentState: 'RTO-Delivered', orderState: 'Cancelled' },
      ],
      // Flow A2: RTO sequence after on_cancel (Initiated → Delivered)
      'a2': [
        { fulfillmentState: 'RTO-Initiated', orderState: 'Cancelled' },
        { fulfillmentState: 'RTO-Delivered', orderState: 'Cancelled' },
      ],
    };

    const steps = sequences[type];
    if (!steps) return res.status(400).json({ error: `Unknown type: ${type}. Use 3a, 3b, rto_initiated, rto_delivered, or a2` });

    // Respond immediately, send callbacks in background
    res.json({ success: true, message: `on_status sequence (${type}) started`, steps: steps.length, order_id });

    // Send each state with 2s delay
    const delay = ms => new Promise(r => setTimeout(r, ms));
    for (const step of steps) {
      const payload = buildStatusPayload(order_id, order, step.fulfillmentState, step.orderState, vendor);
      await sendCallback(context.bap_uri, 'on_status', { ...context, message_id: uuidv4() }, { order: payload }, tenant);
      // Track last sent state so handleStatus can return correct state on /status
      const seqEntry = confirmedOrderCache.get(order_id);
      if (seqEntry) seqEntry.currentFulfillmentState = step.fulfillmentState;
      logger.info('on_status sequence step sent', { order_id, ...step });
      await delay(2000);
    }
    logger.info('on_status sequence complete', { order_id, type });
  } catch (err) {
    logger.error('triggerMerchantStatusSequence failed:', err.message);
  }
};

const handleTrack = async (req, res) => {
  try {
    const body     = req.body;
    const context  = body.context;
    const order_id = body.message?.order_id;
    logger.info('ONDC /track received', { order_id });

    await ack(res, context);

    const tenant = await resolveTenant(context?.bpp_id);
    if (!tenant?.id && !process.env.ONDC_SIGNING_PRIVATE_KEY) return;

    try {
      const [rows] = tenant.id
        ? await pool.query(
            `SELECT * FROM ondc_orders WHERE ondc_order_id = ? AND tenant_id = ?`,
            [order_id, tenant.id]
          )
        : await pool.query(
            `SELECT * FROM ondc_orders WHERE ondc_order_id = ? LIMIT 1`,
            [order_id]
          );
      const dbOrder = rows[0];

      let trackingUrl    = null;
      let trackingStatus = 'active';

      if (dbOrder?.cottkart_order_id) {
        try {
          const tracking = await cottKartOrder.fetchTrackingInfo(dbOrder.cottkart_order_id);
          if (tracking?.tracking_url) trackingUrl    = tracking.tracking_url;
          if (tracking?.status)       trackingStatus = tracking.status;
        } catch (e) {
          logger.warn('Tracking fetch failed:', e.message);
        }
      }

      const cachedTrack = confirmedOrderCache.get(order_id);
      const trackVendor = tenant.id
        ? (cachedTrack?.vendor || await fetchVendorForOrder(tenant.id, cachedTrack?.order?.provider?.id))
        : cachedTrack?.vendor || null;
      const trackNow = new Date().toISOString();
      const trackGps = trackVendor?.gps || '12.914082,77.638980';
      const subscriberUrl = tenant.subscriber_url || process.env.ONDC_SUBSCRIBER_URL;

      await sendCallback(context.bap_uri, 'on_track', context, {
        tracking: {
          id:     order_id,
          url:    trackingUrl || `${subscriberUrl}/track/${order_id}`,
          status: trackingStatus,
          location: {
            gps:        trackGps,
            updated_at: trackNow,
            time:       { timestamp: trackNow },
          },
          tags: ORDER_TAGS,
        },
      }, tenant);

      // Relay /track to logistics LSP (Flow A1) — fire-and-forget
      relayTrackToLogistics(order_id, context).catch(() => {});
    } catch (err) {
      logger.error('handleTrack processing failed:', err.message);
    }
  } catch (err) {
    logger.error('handleTrack failed:', err.message);
  }
};

const handleSupport = async (req, res) => {
  try {
    const body    = req.body;
    const context = body.context;
    logger.info('ONDC /support received');

    ack(res, context);

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return;

    await sendCallback(context.bap_uri, 'on_support', context, {
      support: {
        ref_id:          body.message?.ref_id,
        callback_phone:  process.env.SUPPORT_PHONE || '+919999999999',
        email:           process.env.SUPPORT_EMAIL || 'support@cottkart.com',
        chat_link:       `${tenant.subscriber_url}/support`,
      },
    }, tenant);
  } catch (err) {
    logger.error('handleSupport failed:', err.message);
  }
};

const handleRating = async (req, res) => {
  try {
    const body    = req.body;
    const context = body.context;
    const { id, rating_category, value } = body.message || {};
    logger.info('ONDC /rating received', { id, rating_category, value });

    ack(res, context);

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return;

    // Persist rating in sync_logs (no dedicated ratings table yet)
    pool.query(
      `INSERT INTO sync_logs (tenant_id, sync_type, status, details, completed_at)
       VALUES (?, 'rating', 'success', ?, NOW())`,
      [tenant.id, JSON.stringify({ id, rating_category, value, transaction_id: context?.transaction_id })]
    ).catch(() => {});

    await sendCallback(context.bap_uri, 'on_rating', context, {
      feedback_form: {
        form:     { url: `${tenant.subscriber_url}/feedback` },
        required: false,
      },
    }, tenant);
  } catch (err) {
    logger.error('handleRating failed:', err.message);
  }
};

const handleInfo = async (req, res) => {
  try {
    const body    = req.body;
    const context = body.context;
    logger.info('ONDC /info received');

    ack(res, context);

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return;

    // on_info returns BPP entity/KYC information (GST, PAN, bank details)
    const cityCode = process.env.ONDC_CITY_CODE || context?.city || 'std:080';
    const info = {
      type: 'SELLER_NP',
      entity: {
        gst: {
          legal_entity_name:  process.env.INFO_GST_LEGAL_NAME   || 'CottKart Private Limited',
          business_address:   process.env.INFO_GST_ADDRESS       || '123, MG Road, Bengaluru, Karnataka - 560001',
          city_code:          [cityCode === '*' ? 'std:080' : cityCode],
          gst_no:             process.env.INFO_GST_NO            || '29AABCT1332L1Z1',
        },
        pan: {
          name_as_per_pan:       process.env.INFO_PAN_NAME        || 'CottKart Private Limited',
          pan_no:                process.env.INFO_PAN_NO          || 'AABCT1332L',
          date_of_incorporation: process.env.INFO_DATE_OF_INCORP  || '2020-01-01',
        },
        name_of_authorised_signatory:    process.env.INFO_SIGNATORY_NAME    || 'Authorised Signatory',
        address_of_authorised_signatory: process.env.INFO_SIGNATORY_ADDRESS || '123, MG Road, Bengaluru, Karnataka - 560001',
        email_id:   process.env.SUPPORT_EMAIL || 'support@cottkart.com',
        mobile_no:  Number((process.env.SUPPORT_PHONE || '+919999999999').replace(/\D/g, '').slice(-10)),
        country:    process.env.ONDC_COUNTRY_CODE || 'IND',
        bank_details: {
          account_no:       process.env.INFO_BANK_ACCOUNT    || '1234567890',
          ifsc_code:        process.env.INFO_BANK_IFSC       || 'HDFC0001234',
          beneficiary_name: process.env.INFO_BANK_BENEFICIARY || 'CottKart Private Limited',
          bank_name:        process.env.INFO_BANK_NAME       || 'HDFC Bank',
          branch_name:      process.env.INFO_BANK_BRANCH     || 'MG Road, Bengaluru',
        },
      },
    };

    await sendCallback(context.bap_uri, 'on_info', context, { info }, tenant);
  } catch (err) {
    logger.error('handleInfo failed:', err.message);
  }
};

// ═══ IGM 2.0 HELPERS ════════════════════════════════════════════════════════════

/** Enhance context for IGM 2.0: add location object + version field */
const buildIgmContext = (ctx) => {
  const out = { ...ctx };
  if (!out.version) out.version = out.core_version || '2.0.0';
  if (!out.location) {
    out.location = {
      country: { code: out.country || 'IND' },
      city:    { code: out.city    || 'std:080' },
    };
  }
  return out;
};

/** Create a BPP respondent action entry (IGM 2.0 format) */
const makeBppIgmAction = (code, short_desc, updatedBy, ts, refId = '') => ({
  id:          uuidv4(),
  ref_id:      refId,
  descriptor:  {
    code,
    name:      code.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    short_desc,
  },
  updated_at:  ts,
  action_by:   updatedBy.org?.name || '',
  actor_details: {
    name:    updatedBy.person?.name || 'Support Desk',
    contact: updatedBy.contact || {},
  },
});

/**
 * Build a complete IGM 2.0 message body for on_issue / on_issue_status callbacks.
 * Echoes all IGM 2.0 fields from the original /issue (actors, refs, descriptor, etc.)
 * and appends BPP actions to the actions array.
 */
const buildIgmMessage = (origIssue, origContext, bppSubscriberId, allBppActions, status, extraFields = {}) => {
  const bapActions    = origIssue.actions || [];
  const lastBppAction = allBppActions[allBppActions.length - 1];
  const now           = new Date().toISOString();

  const issueBody = {
    id:     origIssue.id,
    status,
    level:  'ISSUE',
    // IGM 2.0: complainant / source / respondent identifiers
    complainant_id: origIssue.complainant_id || origIssue.actors?.[0]?.actor_id || origContext?.bap_id,
    source_id:      origIssue.source_id      || origIssue.actors?.[0]?.actor_id || origContext?.bap_id,
    respondent_ids: [bppSubscriberId],
    // Echo back IGM 2.0 arrays from original /issue
    refs:    origIssue.refs    || [],
    actors:  origIssue.actors  || [],
    descriptor: origIssue.descriptor || {
      code:       origIssue.category || 'ITEM',
      short_desc: origIssue.description?.short_desc || 'Issue reported',
      long_desc:  origIssue.description?.long_desc  || '',
      images:     origIssue.description?.images     || [],
    },
    order_details:            origIssue.order_details,
    expected_response_time:   { duration: 'PT2H' },
    expected_resolution_time: { duration: 'P1D'  },
    // IGM 1.x respondent_actions (backwards compat — use new format keys)
    issue_actions: {
      respondent_actions: allBppActions.map(a => ({
        respondent_action: (() => { const c = a.descriptor?.code || a.respondent_action; return c === 'NEED-MORE-INFO' ? 'PROCESSING' : c; })(),
        short_desc:        a.descriptor?.short_desc || a.short_desc,
        updated_at:        a.updated_at,
        updated_by: a.action_by ? {
          org:     { name: a.action_by },
          contact: a.actor_details?.contact || { phone: process.env.SUPPORT_PHONE || '', email: process.env.SUPPORT_EMAIL || '' },
          person:  { name: a.actor_details?.name || 'Support Desk' },
        } : a.updated_by,
        cascaded_level: 1,
      })),
    },
    // IGM 2.0: full ordered actions array (BAP actions first, then BPP actions)
    actions:        [...bapActions, ...allBppActions],
    last_action_id: lastBppAction?.id,
    created_at: origIssue.created_at || now,
    updated_at: now,
    ...extraFields,
  };

  // Strip undefined top-level keys
  Object.keys(issueBody).forEach(k => issueBody[k] === undefined && delete issueBody[k]);

  return {
    update_target: [{ path: 'issue', action: 'APPENDED' }],
    level: 'ISSUE',
    issue: issueBody,
  };
};

// ═══ IGM HANDLERS ════════════════════════════════════════════════════════════

const handleIssue = async (req, res) => {
  try {
    const body    = req.body;
    const context = body.context;
    const issue   = body.message?.issue || {};
    logger.info('ONDC /issue received', { transaction_id: context?.transaction_id });

    ack(res, context);

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return;

    const issueId    = issue.id || uuidv4();
    const issueStatus = issue.status;

    // If issue status is CLOSED — BAP is closing/rating the issue (Flow 6F Escalation).
    // BPP must send a final on_issue confirming the closure ("Resolution Provided").
    if (issueStatus === 'CLOSED') {
      const closeCached = issueCache.get(issueId);
      if (!closeCached) {
        logger.info('Issue CLOSED received with no cached issue — ACK only', { issue_id: issueId });
        return;
      }
      const closeNow    = new Date().toISOString();
      const closeUpdatedBy = {
        org:     { name: tenant.subscriber_id },
        contact: { phone: process.env.SUPPORT_PHONE || '', email: process.env.SUPPORT_EMAIL || '' },
        person:  { name: 'Support Desk' },
      };
      const closeAction = makeBppIgmAction('RESOLVED', 'Issue closure acknowledged — resolution confirmed', closeUpdatedBy, closeNow);
      const bppActClose = [...(closeCached.bppActions || []), closeAction];
      issueCache.set(issueId, { ...closeCached, stage: 5, bppActions: bppActClose });

      const igmCtxClose = buildIgmContext(closeCached.context || context);
      const closeRemarks = 'Issue has been closed and resolution confirmed';
      await sendCallback(
        (closeCached.context || context).bap_uri, 'on_issue',
        { ...igmCtxClose, message_id: uuidv4() },
        buildIgmMessage(closeCached.issue || issue, closeCached.context || context, tenant.subscriber_id, bppActClose, 'CLOSED', {
          resolution: {
            network_issue_id:   issueId,
            short_desc:         closeRemarks,
            long_desc:          closeRemarks,
            resolution_remarks: closeRemarks,
            resolution_action:  'RESOLVE',
            action_triggered:   closeCached.resolveAction || 'REFUND',
            refund_amount:      '0.00',
          },
        }),
        tenant
      );
      logger.info('on_issue (CLOSED — Resolution Provided) sent for Flow 6F', { issue_id: issueId });

      // Also send on_issue_status(CLOSED) — required by Pramaan A3 as "(II)"
      await sendCallback(
        (closeCached.context || context).bap_uri, 'on_issue_status',
        { ...igmCtxClose, message_id: uuidv4() },
        buildIgmMessage(closeCached.issue || issue, closeCached.context || context, tenant.subscriber_id, bppActClose, 'CLOSED', {
          resolution: {
            network_issue_id:   issueId,
            short_desc:         closeRemarks,
            long_desc:          closeRemarks,
            resolution_remarks: closeRemarks,
            resolution_action:  'RESOLVE',
            action_triggered:   closeCached.resolveAction || 'REFUND',
            refund_amount:      '0.00',
          },
          resolution_provider: {
            respondent_info: {
              type:         'TRANSACTION-COUNTERPARTY-NP',
              organization: closeUpdatedBy,
              resolution_support: {
                respondentEmail: process.env.SUPPORT_EMAIL || '',
                contact: { phone: process.env.SUPPORT_PHONE || '', email: process.env.SUPPORT_EMAIL || '' },
                gros: [],
                chat_link: '',
              },
            },
          },
        }),
        tenant
      );
      logger.info('on_issue_status (CLOSED) sent after BAP closure — Flow A3 (II)', { issue_id: issueId });
      return;
    }

    try {
      await pool.query(`
        INSERT INTO issue_grievances
          (tenant_id, transaction_id, issue_id, order_id, issue_type, category,
           sub_category, description, status,
           complainant_name, complainant_phone, complainant_email, raw_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = 'open', updated_at = NOW()
      `, [
        tenant.id,
        context.transaction_id,
        issueId,
        issue.order_details?.id || issue.refs?.[0]?.ref_id,
        issue.issue_type  || 'FULFILLMENT',
        issue.category || issue.descriptor?.code,
        issue.sub_category,
        issue.description || issue.descriptor?.short_desc,
        issue.complainant_info?.person?.name || issue.actors?.[0]?.info?.person?.name,
        issue.complainant_info?.contact?.phone || issue.actors?.[0]?.info?.contact?.phone,
        issue.complainant_info?.contact?.email || issue.actors?.[0]?.info?.contact?.email,
        JSON.stringify(body),
      ]);
    } catch (e) {
      logger.warn('Issue save failed:', e.message);
    }

    const cached = issueCache.get(issueId);
    const stage  = cached?.stage || 0;
    const now    = new Date().toISOString();

    const updatedBy = {
      org:     { name: tenant.subscriber_id },
      contact: { phone: process.env.SUPPORT_PHONE || '', email: process.env.SUPPORT_EMAIL || '' },
      person:  { name: 'Support Desk' },
    };

    const igmCtx = buildIgmContext(context);

    if (stage === 0) {
      // ── Full auto-chain: all 5 on_issue callbacks sent automatically ──
      // Pramaan's automated certification flow does NOT send additional /issue
      // requests — BPP must auto-chain the entire sequence from a single /issue.
      //
      // Timeline:
      //   t=0s:  on_issue #1 — PROCESSING (issue received)
      //   t=2s:  on_issue #2 — NEED-MORE-INFO (with additional_info_required)
      //   t=4s:  on_issue #3 — PROCESSING (information received, processing)
      //   t=6s:  on_issue #4 — RESOLVED   (resolution options / refund offered)
      //   t=8s:  on_issue #5 — RESOLVED   (resolution provided / confirmed)
      //   then:  update DB → on_issue_status will return CLOSED

      // Detect resolution type from incoming issue (IGM 2.0: expected_resolution.action,
      // or tags, or sub_category mapping). Falls back to REFUND.
      const SUB_CAT_RESOLUTION = {
        FLM06: 'REPLACEMENT', FLM05: 'CANCEL', FLM07: 'NO-ACTION',
        ITM04: 'REPLACEMENT', ITM05: 'CANCEL', ITM06: 'NO-ACTION',
        PMT03: 'REFUND',
      };
      const resolutionAction =
        issue.expected_resolution?.action                                             ||
        issue.tags?.find?.(t => t.code === 'resolution_action')?.value?.toUpperCase() ||
        SUB_CAT_RESOLUTION[issue.sub_category]                                        ||
        'REFUND';
      logger.info('IGM resolution action detected', { issue_id: issueId, resolutionAction, sub_category: issue.sub_category });

      // Mark as in-progress (stage 1) so any duplicate /issue is ignored
      const processingAction = makeBppIgmAction('PROCESSING', 'Issue received and being processed', updatedBy, now);
      issueCache.set(issueId, { issue, context, tenant, stage: 1, bppActions: [processingAction], resolveAction: resolutionAction });
      lastIssueId = issueId;
      logger.info('IGM auto-chain started (stage 0→1)', { issue_id: issueId });

      // ── Callback 1: PROCESSING ──────────────────────────────────────────────
      await sendCallback(
        context.bap_uri, 'on_issue',
        { ...igmCtx, message_id: uuidv4() },
        buildIgmMessage(issue, context, tenant.subscriber_id, [processingAction], 'OPEN'),
        tenant
      );

      // ── Callback 2: NEED-MORE-INFO (t+2s) ──────────────────────────────────
      setTimeout(async () => {
        try {
          const nmiNow    = new Date().toISOString();
          const nmiAction = makeBppIgmAction('NEED-MORE-INFO', 'Please share additional details about the issue', updatedBy, nmiNow);
          const latest2   = issueCache.get(issueId);
          const bppAct2   = [...(latest2?.bppActions || [processingAction]), nmiAction];
          issueCache.set(issueId, { ...(latest2 || { issue, context, tenant }), stage: 1, bppActions: bppAct2 });

          await sendCallback(
            context.bap_uri, 'on_issue',
            { ...igmCtx, message_id: uuidv4() },
            buildIgmMessage(issue, context, tenant.subscriber_id, bppAct2, 'OPEN', {
              additional_info_required: [{
                info_required: {
                  issue_update_info: {
                    code:       'REASON',
                    name:       'Additional information required',
                    short_desc: 'Please share additional details (e.g. photos, order reference) to help process your refund',
                  },
                  updated_at: nmiNow,
                  message_id: uuidv4(),
                },
              }],
            }),
            tenant
          );
          logger.info('on_issue #2 (NEED-MORE-INFO) sent', { issue_id: issueId });
        } catch (err) { logger.error('on_issue #2 failed:', err.message); }
      }, 2000);

      // ── Callback 3: PROCESSING after share info (t+4s) ─────────────────────
      setTimeout(async () => {
        try {
          const p2Now    = new Date().toISOString();
          const p2Action = makeBppIgmAction('PROCESSING', 'Information received, processing resolution', updatedBy, p2Now);
          const latest3  = issueCache.get(issueId);
          const bppAct3  = [...(latest3?.bppActions || []), p2Action];
          issueCache.set(issueId, { ...(latest3 || { issue, context, tenant }), stage: 1, bppActions: bppAct3 });

          await sendCallback(
            context.bap_uri, 'on_issue',
            { ...igmCtx, message_id: uuidv4() },
            buildIgmMessage(issue, context, tenant.subscriber_id, bppAct3, 'OPEN'),
            tenant
          );
          logger.info('on_issue #3 (PROCESSING) sent', { issue_id: issueId });
        } catch (err) { logger.error('on_issue #3 failed:', err.message); }
      }, 4000);

      // ── Callback 4: RESOLVED — resolution options offered (t+6s) ───────────
      setTimeout(async () => {
        try {
          const ro4Now   = new Date().toISOString();
          const ro4Action = makeBppIgmAction(
            'RESOLVED',
            `Resolution offered — ${resolutionAction.toLowerCase()} will be processed within 4-5 business days`,
            updatedBy, ro4Now
          );
          const latest4  = issueCache.get(issueId);
          const bppAct4  = [...(latest4?.bppActions || []), ro4Action];
          issueCache.set(issueId, { ...(latest4 || { issue, context, tenant }), stage: 1, bppActions: bppAct4 });

          await sendCallback(
            context.bap_uri, 'on_issue',
            { ...igmCtx, message_id: uuidv4() },
            buildIgmMessage(issue, context, tenant.subscriber_id, bppAct4, 'OPEN', {
              resolution: {
                network_issue_id:   issueId,
                resolution_remarks: `${resolutionAction.toLowerCase()} will be processed within 4-5 business days`,
                resolution_action:  'RESOLVE',
                action_triggered:   resolutionAction,
                refund_amount:      '0.00',
              },
              resolution_provider: {
                respondent_info: {
                  type:         'TRANSACTION-COUNTERPARTY-NP',
                  organization: updatedBy,
                  resolution_support: {
                    respondentEmail:   process.env.SUPPORT_EMAIL || '',
                    contact: {
                      phone: process.env.SUPPORT_PHONE || '',
                      email: process.env.SUPPORT_EMAIL || '',
                    },
                    gros: [],
                  },
                },
              },
            }),
            tenant
          );
          logger.info('on_issue #4 (RESOLVED/options) sent', { issue_id: issueId });
        } catch (err) { logger.error('on_issue #4 failed:', err.message); }
      }, 6000);

      // ── Callback 5: RESOLVED — resolution confirmed / provided (t+8s) ──────
      setTimeout(async () => {
        try {
          const rp5Now   = new Date().toISOString();
          const rp5Action = makeBppIgmAction(
            'RESOLVED',
            `Resolution provided — ${resolutionAction.toLowerCase()} confirmed`,
            updatedBy, rp5Now
          );
          const latest5  = issueCache.get(issueId);
          const bppAct5  = [...(latest5?.bppActions || []), rp5Action];
          issueCache.set(issueId, { ...(latest5 || { issue, context, tenant }), stage: 5, bppActions: bppAct5 });

          await sendCallback(
            context.bap_uri, 'on_issue',
            { ...igmCtx, message_id: uuidv4() },
            buildIgmMessage(issue, context, tenant.subscriber_id, bppAct5, 'RESOLVED', {
              resolution: {
                network_issue_id:   issueId,
                resolution_remarks: `Resolution confirmed — ${resolutionAction.toLowerCase()} will be processed within 4-5 business days`,
                resolution_action:  'RESOLVE',
                action_triggered:   resolutionAction,
                refund_amount:      '0.00',
              },
            }),
            tenant
          );

          // Update DB so /issue_status returns CLOSED
          pool.query(
            `UPDATE issue_grievances SET status = 'resolved', updated_at = NOW() WHERE issue_id = ? AND tenant_id = ?`,
            [issueId, tenant.id]
          ).catch(e => logger.warn('Issue status update failed:', e.message));

          logger.info('on_issue #5 (RESOLVED/provided) sent — auto-chain complete', { issue_id: issueId });
        } catch (err) { logger.error('on_issue #5 failed:', err.message); }
      }, 8000);

      // ── Proactive on_issue_status CLOSED (t+9s) ─────────────────────────────
      // Registered at stage-0 start so it fires exactly 9s after /issue received,
      // independent of how long on_issue callbacks take.
      // Pramaan Flow 6A captures this as "on_issue_status (II)".
      setTimeout(async () => {
        try {
          const proactiveUpdatedBy = {
            org:     { name: tenant.subscriber_id },
            contact: { phone: process.env.SUPPORT_PHONE || '', email: process.env.SUPPORT_EMAIL || '' },
            person:  { name: 'Support Desk' },
          };
          const latestFinal  = issueCache.get(issueId);
          const finalActions = latestFinal?.bppActions || [];
          const proactiveRemarks = `Resolution confirmed — ${resolutionAction.toLowerCase()} will be processed within 4-5 business days`;
          await sendCallback(
            context.bap_uri, 'on_issue_status',
            { ...igmCtx, message_id: uuidv4() },
            buildIgmMessage(issue, context, tenant.subscriber_id, finalActions, 'CLOSED', {
              resolution: {
                network_issue_id:   issueId,
                short_desc:         proactiveRemarks,
                long_desc:          proactiveRemarks,
                resolution_remarks: proactiveRemarks,
                resolution_action:  'RESOLVE',
                action_triggered:   resolutionAction,
                refund_amount:      '0.00',
              },
              resolution_provider: {
                respondent_info: {
                  type:         'TRANSACTION-COUNTERPARTY-NP',
                  organization: proactiveUpdatedBy,
                  resolution_support: {
                    respondentEmail: process.env.SUPPORT_EMAIL || '',
                    contact: { phone: process.env.SUPPORT_PHONE || '', email: process.env.SUPPORT_EMAIL || '' },
                    gros: [],
                    chat_link: '',
                  },
                },
              },
            }),
            tenant
          );
          logger.info('Proactive on_issue_status CLOSED sent (t+9s)', { issue_id: issueId });
        } catch (err) { logger.error('Proactive on_issue_status failed:', err.message); }
      }, 9000);

    } else if (issueStatus === 'ESCALATED') {
      // ── Escalation flow (Flow 6F) ────────────────────────────────────────────
      // BAP escalated the issue — send PROCESSING then auto RESOLVED (t+3s)
      logger.info('Escalated issue received — sending escalation response', { issue_id: issueId, stage });

      const resolutionAction = cached?.resolveAction ||
        issue.expected_resolution?.action ||
        'REFUND';

      const escNow    = new Date().toISOString();
      const escAction = makeBppIgmAction('PROCESSING', 'Escalation received, reviewing the issue', updatedBy, escNow);
      const bppActEsc = [...(cached?.bppActions || []), escAction];
      issueCache.set(issueId, { ...(cached || { issue, context, tenant }), stage: 1, bppActions: bppActEsc });

      await sendCallback(
        context.bap_uri, 'on_issue',
        { ...igmCtx, message_id: uuidv4() },
        buildIgmMessage(issue, context, tenant.subscriber_id, bppActEsc, 'OPEN'),
        tenant
      );
      logger.info('on_issue (escalation PROCESSING) sent', { issue_id: issueId });

      // Auto-send RESOLVED after 3s
      setTimeout(async () => {
        try {
          const escResNow    = new Date().toISOString();
          const escResAction = makeBppIgmAction(
            'RESOLVED',
            `Escalation resolved — ${resolutionAction.toLowerCase()} confirmed`,
            updatedBy, escResNow
          );
          const latestEsc  = issueCache.get(issueId);
          const bppActEscR = [...(latestEsc?.bppActions || bppActEsc), escResAction];
          issueCache.set(issueId, { ...(latestEsc || { issue, context, tenant }), stage: 5, bppActions: bppActEscR });

          await sendCallback(
            context.bap_uri, 'on_issue',
            { ...igmCtx, message_id: uuidv4() },
            buildIgmMessage(issue, context, tenant.subscriber_id, bppActEscR, 'RESOLVED', {
              resolution: {
                network_issue_id:   issueId,
                resolution_remarks: `Escalation resolved — ${resolutionAction.toLowerCase()} will be processed within 4-5 business days`,
                resolution_action:  'RESOLVE',
                action_triggered:   resolutionAction,
                refund_amount:      '0.00',
                resolution_type:    resolutionAction,
              },
            }),
            tenant
          );

          pool.query(
            `UPDATE issue_grievances SET status = 'resolved', updated_at = NOW() WHERE issue_id = ? AND tenant_id = ?`,
            [issueId, tenant.id]
          ).catch(e => logger.warn('Issue status update failed:', e.message));

          logger.info('on_issue (escalation RESOLVED) sent', { issue_id: issueId });
        } catch (err) { logger.error('on_issue escalation RESOLVED failed:', err.message); }
      }, 3000);

    } else {
      // Stage 1+ — auto-chain already running or complete — ACK only
      logger.info('Issue received (auto-chain in progress/complete) — ACK only', { issue_id: issueId, stage });
    }
  } catch (err) {
    logger.error('handleIssue failed:', err.message);
  }
};

const handleIssueStatus = async (req, res) => {
  try {
    const body     = req.body;
    const context  = body.context;
    // Support both message.issue_id (standard) and message.issue.id (some versions)
    const issue_id = body.message?.issue_id || body.message?.issue?.id;
    logger.info('ONDC /issue_status received', { issue_id, txn: context?.transaction_id });

    await ack(res, context);

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return;

    let dbStatus   = 'OPEN';
    let resolution = null;
    try {
      const [rows] = await pool.query(
        `SELECT * FROM issue_grievances WHERE issue_id = ? AND tenant_id = ?`,
        [issue_id, tenant.id]
      );
      if (rows.length) {
        dbStatus   = (rows[0].status || 'open').toUpperCase();
        resolution = rows[0].resolution;
      }
    } catch (e) {}

    const now       = new Date().toISOString();
    const updatedBy = {
      org:     { name: tenant.subscriber_id },
      contact: { phone: process.env.SUPPORT_PHONE || '', email: process.env.SUPPORT_EMAIL || '' },
      person:  { name: 'Support Desk' },
    };

    // Get original issue from cache for IGM 2.0 echo fields
    const cached    = issue_id ? issueCache.get(issue_id) : null;
    const origIssue = cached?.issue || { id: issue_id, actions: [], actors: [], refs: [] };
    const origCtx   = cached?.context || context;

    // Use cache stage (>=5 = Resolution Provided sent) as fallback for DB-resolved check
    const isResolved = dbStatus === 'RESOLVED' || (cached?.stage || 0) >= 5;

    const statusAction  = makeBppIgmAction(
      isResolved ? 'RESOLVED' : 'PROCESSING',
      resolution || (isResolved ? 'Issue resolved' : 'Being processed'),
      updatedBy, now
    );
    const allBppActions = [...(cached?.bppActions || []), statusAction];

    const resolutionRemarks = resolution || 'Issue has been resolved';
    const extraFields = isResolved ? {
      resolution: {
        network_issue_id:   issue_id,
        short_desc:         resolutionRemarks,
        long_desc:          resolutionRemarks,
        resolution_remarks: resolutionRemarks,
        resolution_action:  'RESOLVE',
        action_triggered:   cached?.resolveAction || 'REFUND',
        refund_amount:      '0.00',
      },
      resolution_provider: {
        respondent_info: {
          type:         'TRANSACTION-COUNTERPARTY-NP',
          organization: updatedBy,
          resolution_support: {
            respondentEmail:   process.env.SUPPORT_EMAIL || '',
            contact: { phone: process.env.SUPPORT_PHONE || '', email: process.env.SUPPORT_EMAIL || '' },
            gros: [],
            chat_link:         '',
          },
        },
      },
    } : {};

    // Build response context: merge origCtx (for issue-level fields) with current request context
    // Prefer current /issue_status context for routing (bap_uri, transaction_id) so Pramaan
    // can match on_issue_status (II) to the /issue_status test step (Flow A3).
    const responseCtx = buildIgmContext({
      ...origCtx,
      bap_uri:        context.bap_uri        || origCtx.bap_uri,
      transaction_id: context.transaction_id || origCtx.transaction_id,
    });

    const callbackUri = context.bap_uri || origCtx.bap_uri;

    logger.info('Sending on_issue_status', { issue_id, isResolved, callbackUri, txn: responseCtx.transaction_id });

    await sendCallback(
      callbackUri, 'on_issue_status',
      { ...responseCtx, message_id: uuidv4() },
      buildIgmMessage(origIssue, origCtx || context, tenant.subscriber_id, allBppActions, isResolved ? 'CLOSED' : 'OPEN', extraFields),
      tenant
    );

    logger.info('on_issue_status sent', { issue_id, status: isResolved ? 'CLOSED' : 'OPEN' });

    // For auto-resolved flows (Pramaan A3): if not yet resolved when /issue_status arrived,
    // send a follow-up CLOSED once auto-chain completes (~12s from now).
    // This ensures on_issue_status (II) is always sent as CLOSED even if BAP asks early.
    if (!isResolved) {
      setTimeout(async () => {
        try {
          const latestCached = issue_id ? issueCache.get(issue_id) : null;
          let latestDbResolved = false;
          try {
            const [latestRows] = await pool.query(
              `SELECT status FROM issue_grievances WHERE issue_id = ? AND tenant_id = ?`,
              [issue_id, tenant.id]
            );
            latestDbResolved = latestRows.length && (latestRows[0].status || '').toUpperCase() === 'RESOLVED';
          } catch (e) {}

          if (!latestDbResolved && (latestCached?.stage || 0) < 5) {
            logger.info('on_issue_status deferred follow-up: still not resolved, skipping', { issue_id });
            return;
          }

          const followUpAction = makeBppIgmAction('RESOLVED', 'Issue resolved and closed', updatedBy, new Date().toISOString());
          const followUpActions = [...(latestCached?.bppActions || allBppActions), followUpAction];
          const followUpRemarks = resolution || 'Issue has been resolved';
          const followUpExtra = {
            resolution: {
              network_issue_id:   issue_id,
              short_desc:         followUpRemarks,
              long_desc:          followUpRemarks,
              resolution_remarks: followUpRemarks,
              resolution_action:  'RESOLVE',
              action_triggered:   latestCached?.resolveAction || cached?.resolveAction || 'REFUND',
              refund_amount:      '0.00',
            },
            resolution_provider: {
              respondent_info: {
                type:         'TRANSACTION-COUNTERPARTY-NP',
                organization: updatedBy,
                resolution_support: {
                  respondentEmail: process.env.SUPPORT_EMAIL || '',
                  contact: { phone: process.env.SUPPORT_PHONE || '', email: process.env.SUPPORT_EMAIL || '' },
                  gros: [],
                  chat_link: '',
                },
              },
            },
          };
          await sendCallback(
            callbackUri, 'on_issue_status',
            { ...responseCtx, message_id: uuidv4() },
            buildIgmMessage(origIssue, origCtx || context, tenant.subscriber_id, followUpActions, 'CLOSED', followUpExtra),
            tenant
          );
          logger.info('on_issue_status deferred CLOSED sent (A3 follow-up)', { issue_id });
        } catch (e) {
          logger.warn('on_issue_status deferred follow-up failed:', e.message);
        }
      }, 12000);
    }
  } catch (err) {
    logger.error('handleIssueStatus failed:', err.message);
  }
};

// triggerIssueResolve — sends proactive on_issue_status with RESOLVED
// Body: { action: 'REFUND' | 'REPLACEMENT' | 'CANCEL' | 'NO_ACTION', short_desc?: string }
const triggerIssueResolve = async (req, res) => {
  try {
    const rawId    = req.params.issue_id;
    const issue_id = rawId === 'latest' ? lastIssueId : rawId;
    if (!issue_id) return res.status(404).json({ error: 'No issue in cache' });

    const cached = issueCache.get(issue_id);
    if (!cached) return res.status(404).json({ error: 'Issue not found in cache' });

    const { context, tenant, issue: origIssue } = cached;
    const action    = req.body?.action    || 'REFUND';
    const shortDesc = req.body?.short_desc || `Issue resolved with ${action.toLowerCase()}`;

    // Pre-set resolve action in cache for on_issue resolution options
    issueCache.set(issue_id, { ...cached, resolveAction: action });

    const now       = new Date().toISOString();
    const updatedBy = {
      org:     { name: tenant.subscriber_id },
      contact: { phone: process.env.SUPPORT_PHONE || '', email: process.env.SUPPORT_EMAIL || '' },
      person:  { name: 'Support Desk' },
    };

    const resolvedAction = makeBppIgmAction('RESOLVED', shortDesc, updatedBy, now);
    const allBppActions  = [...(cached?.bppActions || []), resolvedAction];
    const safeOrigIssue  = origIssue || { id: issue_id, actions: [], actors: [], refs: [] };

    await sendCallback(
      context.bap_uri, 'on_issue_status',
      { ...buildIgmContext(context), message_id: uuidv4() },
      buildIgmMessage(safeOrigIssue, context, tenant.subscriber_id, allBppActions, 'CLOSED', {
        resolution: {
          network_issue_id:   issue_id,
          short_desc:         shortDesc,
          long_desc:          shortDesc,
          resolution_remarks: shortDesc,
          resolution_action:  'RESOLVE',
          action_triggered:   action,
          refund_amount:      '0.00',
        },
        resolution_provider: {
          respondent_info: {
            type:         'TRANSACTION-COUNTERPARTY-NP',
            organization: updatedBy,
            resolution_support: {
              respondentEmail:   process.env.SUPPORT_EMAIL || '',
              contact: { phone: process.env.SUPPORT_PHONE || '', email: process.env.SUPPORT_EMAIL || '' },
              gros: [],
              chat_link:         '',
            },
          },
        },
      }),
      tenant
    );

    logger.info('Proactive on_issue_status (RESOLVED) sent', { issue_id, action });
    res.json({ success: true, message: `on_issue_status RESOLVED sent`, issue_id, action });
  } catch (err) {
    logger.error('triggerIssueResolve failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// Flow 5: Force items out of stock for testing (without touching DB)
const triggerSetOutOfStock = (req, res) => {
  const { item_ids, item_id } = req.body || {};
  const ids = item_ids || (item_id ? [item_id] : []);
  if (!ids.length) return res.status(400).json({ error: 'Provide item_id or item_ids array' });
  for (const id of ids) forcedOutOfStockItems.add(String(id));
  logger.info('forcedOutOfStockItems set', { items: [...forcedOutOfStockItems] });
  res.json({ success: true, forcedOutOfStockItems: [...forcedOutOfStockItems] });
};

const triggerClearOutOfStock = (req, res) => {
  forcedOutOfStockItems.clear();
  logger.info('forcedOutOfStockItems cleared');
  res.json({ success: true, message: 'Forced out-of-stock cleared' });
};

// Generic ACK for ONDC callbacks we receive (on_*)
const handleACK = (action) => async (req, res) => {
  logger.info(`ONDC /${action} received`);
  const context = req.body?.context;
  const body = buildAckBody(context);
  pushTxnLog(`${action}_response`, body).catch(() => {});
  res.json(body);
};

// ─── Flow 11A — RSF 2.0 (Reconciliation and Settlement Framework) ────────────
// BPP receives /recon from BAP (domain:ONDC:NTS10, version:2.0.0, message.orders format),
// ACKs, then sends on_recon callback echoing back the orders with recon_status:"01".
const handleRecon = async (req, res) => {
  try {
    const { context, message } = req.body;
    logger.info('ONDC /recon received', { txn: context?.transaction_id, domain: context?.domain });

    await ack(res, context);

    if (!context?.bap_uri) return;

    // RSF 2.0: Pramaan sends message.orders (not message.settlement.settlements)
    const orders = message?.orders;
    if (!orders?.length) {
      logger.warn('handleRecon: no message.orders in /recon payload, skipping on_recon');
      return;
    }

    const tenant = await getTenantByBppId(context.bpp_id);
    const config  = resolveOndcConfig(tenant);

    // Echo back orders with recon_status="01" and recon_accord=true per order
    const reconOrders = orders.map(order => ({
      ...order,
      recon_accord: true,
      settlements: (order.settlements || []).map(s => ({
        ...s,
        recon_status: '01',
      })),
    }));

    // RSF 2.0 context: preserve only RSF fields — do NOT include core_version/country/city
    const cbCtx = {
      domain:         context.domain,
      location:       context.location,
      version:        context.version,
      action:         'on_recon',
      transaction_id: context.transaction_id,
      message_id:     uuidv4(),
      timestamp:      new Date().toISOString(),
      bap_id:         context.bap_id,
      bap_uri:        context.bap_uri,
      bpp_id:         config.subscriber_id,
      bpp_uri:        config.subscriber_url,
      ttl:            context.ttl || 'PT30S',
    };

    setTimeout(async () => {
      try {
        const payload = { context: cbCtx, message: { orders: reconOrders } };
        const headers = { 'Content-Type': 'application/json' };
        try {
          if (config.signing_private_key) {
            headers['Authorization'] = createAuthHeader(
              config.signing_private_key,
              config.subscriber_id,
              config.unique_key_id,
              payload
            );
          }
        } catch (e) {
          logger.error('on_recon auth header failed:', e.message);
        }
        const callbackUrl = `${context.bap_uri.replace(/\/+$/, '')}/on_recon`;
        const resp = await axios.post(callbackUrl, payload, { headers, timeout: 30000 });
        logger.info(`on_recon → ${callbackUrl} [${resp.status}]`, { txn: context.transaction_id, orders: reconOrders.length });
        pushTxnLog('on_recon', payload).catch(() => {});
      } catch (e) {
        logger.error('on_recon callback failed:', e.message);
      }
    }, 1000);

  } catch (err) {
    logger.error('handleRecon failed:', err.message);
  }
};

// ─── Flow 11B — RSF 2.0 Receiver: BPP sends /recon to BAP ───────────────────
// BPP initiates reconciliation by sending /recon (RSF 2.0 format) to BAP.
// BAP validates the request and sends back on_recon. We ACK it at /on_recon.
// Call: POST /trigger/send-recon-receiver/latest  (or /:order_id)
const triggerSendReconReceiver = async (req, res) => {
  try {
    const orderId = req.params.order_id === 'latest' ? lastConfirmedOrderId : req.params.order_id;
    const cached  = orderId ? confirmedOrderCache.get(orderId) : null;

    if (!cached) {
      return res.status(404).json({ error: 'Order not found in cache. Run Flow 1A first.' });
    }

    const { order, context, tenant } = cached;
    const config = resolveOndcConfig(tenant);
    const amount = order.quote?.price?.value || '0.00';

    // Derive RSF 2.0 location from cached RET10 context
    const cityCode    = context.city || 'std:044';
    const countryCode = context.country || 'IND';

    // RSF 2.0 context for /recon — must NOT include core_version/country/city string fields
    const reconCtx = {
      domain:         'ONDC:NTS10',
      location:       { country: { code: countryCode }, city: { code: cityCode } },
      version:        '2.0.0',
      action:         'recon',
      transaction_id: context.transaction_id,
      message_id:     uuidv4(),
      timestamp:      new Date().toISOString(),
      bap_id:         context.bap_id,
      bap_uri:        context.bap_uri,
      bpp_id:         config.subscriber_id,
      bpp_uri:        config.subscriber_url,
      ttl:            'PT30S',
    };

    const settlementId = uuidv4();
    const moneyObj = (val) => ({ currency: 'INR', value: String(val) });
    const reconOrders = [{
      id:           order.id,
      recon_accord: true,
      amount:       moneyObj(amount),
      settlements:  [{
        id:                settlementId,
        payment_id:        order.payment?.params?.transaction_id || settlementId,
        status:            'SETTLED',
        settlement_ref_no: `REF${Date.now()}`,
        amount:            moneyObj(amount),
        commission:        moneyObj('0.00'),
        withholding_amount: moneyObj('0.00'),
        tcs:               moneyObj('0.00'),
        tds:               moneyObj('0.00'),
        updated_at:        new Date().toISOString(),
      }],
    }];

    const payload = { context: reconCtx, message: { orders: reconOrders } };
    const headers = { 'Content-Type': 'application/json' };

    try {
      if (config.signing_private_key) {
        headers['Authorization'] = createAuthHeader(
          config.signing_private_key,
          config.subscriber_id,
          config.unique_key_id,
          payload
        );
      }
    } catch (e) {
      logger.error('triggerSendReconReceiver auth header failed:', e.message);
    }

    const reconUrl = `${context.bap_uri.replace(/\/+$/, '')}/recon`;
    const resp = await axios.post(reconUrl, payload, { headers, timeout: 30000 });
    logger.info(`/recon (receiver) → ${reconUrl} [${resp.status}]`, { txn: context.transaction_id, order_id: order.id });
    pushTxnLog('recon', payload).catch(() => {});

    res.json({ success: true, order_id: order.id, recon_url: reconUrl, status: resp.status, data: resp.data });
  } catch (err) {
    logger.error('triggerSendReconReceiver failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─── Flow 11A — Proactive on_recon trigger (BPP as collector/initiator) ──────
// After order is delivered, trigger BPP to proactively send on_recon to BAP.
// Call: POST /trigger/send-recon/latest  (or /:order_id)
const triggerSendRecon = async (req, res) => {
  try {
    const orderId = req.params.order_id === 'latest' ? lastConfirmedOrderId : req.params.order_id;
    const cached  = orderId ? confirmedOrderCache.get(orderId) : null;

    if (!cached) {
      return res.status(404).json({ error: 'Order not found in cache. Run Flow 1A first.' });
    }

    const { order, context, tenant } = cached;
    const config = resolveOndcConfig(tenant);
    const amount = order.quote?.price?.value || '0.00';
    const settlementDetails = buildSettlementDetails(amount)[0];

    const cbCtx = {
      ...context,
      action:     'on_recon',
      bpp_id:     config.subscriber_id,
      bpp_uri:    config.subscriber_url,
      message_id: uuidv4(),
      timestamp:  new Date().toISOString(),
    };

    const settlements = [{
      ...settlementDetails,
      payer_app_id:      context.bap_id,
      payer_app_uri:     context.bap_uri,
      receiver_app_id:   config.subscriber_id,
      receiver_app_uri:  config.subscriber_url,
      recon_status:      '01',
      order_details: [{
        id:                    order.id,
        state:                 'Complete',
        provider_id:           order.provider?.id || 'V001',
        withholding_amount:    '0.00',
        reciever_recon_status: '01',
      }],
    }];

    await sendCallback(
      context.bap_uri, 'on_recon', cbCtx,
      { settlement: { settlements } },
      tenant
    );

    logger.info('Proactive on_recon sent', { order_id: order.id, txn: context.transaction_id });
    res.json({ success: true, order_id: order.id, settlement_id: settlementDetails.settlement_id });
  } catch (err) {
    logger.error('triggerSendRecon failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  handleSearch,
  handleSelect,
  handleInit,
  handleConfirm,
  handleStatus,
  handleCancel,
  handleUpdate,
  handleTrack,
  handleSupport,
  handleRating,
  handleInfo,
  handleIssue,
  handleIssueStatus,
  handleRecon,
  triggerSendRecon,
  triggerSendReconReceiver,
  handleACK,
  triggerIssueResolve,
  triggerMerchantUpdate,
  triggerMerchantReturnUpdate,
  triggerMerchantCancel,
  triggerMerchantStatus,
  triggerMerchantStatusSequence,
  triggerSetOutOfStock,
  triggerClearOutOfStock,
};
