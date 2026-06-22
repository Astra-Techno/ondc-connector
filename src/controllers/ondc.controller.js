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
const { ack, buildAckBody } = require('../utils/response');
const { pushTxnLog } = require('../services/ondc/logPublisher.service');

// In-memory cache: order_id → { order, context } (for on_status/on_update/on_cancel callbacks)
const confirmedOrderCache = new Map();
let lastConfirmedOrderId = null; // track most recent for /latest shortcut
// Track cancelled orders so auto-sequence can abort
const cancelledOrders = new Set();

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

const SETTLEMENT_DETAILS = [{
  settlement_counterparty:    'buyer-app',
  settlement_phase:           'sale-amount',
  settlement_type:            'upi',
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

// Flow 3A — merchant partial cancel on_update (Pramaan N.O. key: fulfillment state Cancelled)
const buildPartialCancelUpdatePayload = (order, vendor, confirmTimestamp) => {
  const now = new Date().toISOString();
  const allItems = order.items || [];
  const cancelledItem = allItems[0];
  const remainingItems = allItems.length > 1 ? allItems.slice(1) : [];
  const originalBreakup = order.quote?.breakup || [];
  const updatedBreakup = cancelledItem
    ? originalBreakup.filter(b =>
        !(b['@ondc/org/title_type'] === 'item' && b['@ondc/org/item_id'] === cancelledItem.id)
      )
    : originalBreakup;
  const updatedTotal = updatedBreakup.length > 0
    ? updatedBreakup.reduce((sum, b) => sum + parseFloat(b.price?.value || 0), 0).toFixed(2)
    : order.quote?.price?.value || '0.00';

  return {
    id:       order.id,
    state:    'Accepted',
    provider: order.provider,
    items: [
      ...remainingItems.map(i => ({ ...i })),
      ...(cancelledItem ? [{
        ...cancelledItem,
        tags: [{ code: 'cancellation', list: [{ code: 'reason_id', value: '001' }] }],
      }] : []),
    ],
    billing: order.billing,
    quote: {
      price:   { currency: 'INR', value: updatedTotal },
      breakup: updatedBreakup.length > 0 ? updatedBreakup : originalBreakup,
      ttl:     order.quote?.ttl || 'P1D',
    },
    payment: {
      ...(order.payment || {}),
      '@ondc/org/buyer_app_finder_fee_type':   'percent',
      '@ondc/org/buyer_app_finder_fee_amount': '3',
      '@ondc/org/settlement_basis':             'return_window_expiry',
      '@ondc/org/settlement_window':            'P1D',
      '@ondc/org/withholding_amount':           '10.00',
      '@ondc/org/settlement_details':           SETTLEMENT_DETAILS,
      status: 'PAID',
    },
    fulfillments: (order.fulfillments || [{ id: 'f1', type: 'Delivery' }]).map(f =>
      buildFulfillmentWithLocation(f, vendor, 'Cancelled', now)
    ),
    tags: [{ code: 'cancellation_initiated_by', list: [{ code: 'reason_id', value: '001' }] }],
    created_at: order.created_at || now,
    updated_at: confirmTimestamp || order.updated_at || now,
  };
};

const sendPartialCancelOnUpdate = async (context, order, vendor, tenant, confirmTimestamp) => {
  const cancelPayload = buildPartialCancelUpdatePayload(order, vendor, confirmTimestamp);
  const onUpdatePayload = {
    context: {
      ...context,
      action:     'on_update',
      bpp_id:     process.env.ONDC_SUBSCRIBER_ID || context.bpp_id,
      bpp_uri:    process.env.ONDC_SUBSCRIBER_URL || context.bpp_uri,
      timestamp:  new Date().toISOString(),
      message_id: uuidv4(),
      ttl:        'PT30S',
    },
    message: { order: cancelPayload },
  };
  pushTxnLog('on_update', onUpdatePayload).catch(e =>
    logger.warn('N.O. on_update (Cancelled) push failed:', e.message)
  );
  await sendCallback(context.bap_uri, 'on_update', context, { order: cancelPayload }, tenant);
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
  const [tenants] = await pool.query(`
    SELECT t.*, oc.subscriber_id, oc.subscriber_url,
           oc.signing_private_key, oc.unique_key_id
    FROM tenants t
    JOIN tenant_ondc_config oc ON oc.tenant_id = t.id
    WHERE t.status = 'active' AND oc.is_active = 1
  `);
  return tenants;
};

// Build ONDC catalog from DB for a tenant
const buildCatalog = async (tenantId, ondcConfig, contextCity) => {
  try {
    // Filter vendors strictly by city — prevents GCR catalog_rejection for area_code/city mismatch.
    // Vendors with NULL std_city_code are excluded from city-specific searches (they have no registered city).
    const [vendors] = await pool.query(
      `SELECT * FROM vendors WHERE tenant_id = ? AND status = 'active'
       AND (? IS NULL OR std_city_code = ?)`,
      [tenantId, contextCity, contextCity]
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
          available: { count: String(Math.max(p.stock || 0, 0)) },
          maximum:   { count: String(Math.max(p.stock || 0, 0)) },
        },
        category_id:    'Grocery',
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
          imported_product_country_of_origin:           'IND',
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
        categories: [
          { id: 'Grocery', descriptor: { name: 'Grocery' } },
        ],
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
            range:     {
              start: new Date(new Date().setHours(9,0,0,0)).toISOString(),
              end:   new Date(new Date().setHours(21,0,0,0)).toISOString(),
            },
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
        payment_methods: [{
          '@ondc/org/buyer_app_finder_fee_type':   'percent',
          '@ondc/org/buyer_app_finder_fee_amount': '3',
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

    return providers.length
      ? {
          'bpp/descriptor': {
            name:       ondcConfig?.subscriber_id || 'ONDC Connector',
            symbol:     'https://ondc.cottkart.com/assets/logo.png',
            short_desc: 'ONDC Seller Platform',
            long_desc:  'Multi-vendor ONDC Seller Platform powered by CottKart',
            images:     ['https://ondc.cottkart.com/assets/logo.png'],
            tags: [{
              code: 'bpp_terms',
              list: [
                { code: 'np_type',         value: 'MSN' },
                { code: 'accept_bap_terms', value: 'Y'  },
              ],
            }],
          },
          'bpp/categories': [
            { id: 'Grocery', descriptor: { name: 'Grocery' } },
          ],
          'bpp/providers': providers,
          // Required at catalog level per ONDC API v1.2 spec
          'bpp/fulfillments': [{
            id:   'f1',
            type: 'Delivery',
          }],
          'bpp/payments': [{
            '@ondc/org/buyer_app_finder_fee_type':   'percent',
            '@ondc/org/buyer_app_finder_fee_amount': '3',
          }],
          'bpp/offers': [],
        }
      : null;
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

    for (const tenant of tenants) {
      const ondcConfig = resolveOndcConfig(tenant);
      const catalog = await buildCatalog(tenant.id, ondcConfig, context?.city);
      if (catalog?.['bpp/providers']?.length) {
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
      const { quote, outOfStockItems } = tenantId
        ? await buildQuote(items, tenantId)
        : { quote: { price: { currency: 'INR', value: '30' }, breakup: [], ttl: 'P1D' }, outOfStockItems: [] };

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
            '@ondc/org/settlement_details':           SETTLEMENT_DETAILS,
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
            '@ondc/org/settlement_details':           SETTLEMENT_DETAILS,
            status: 'PAID',
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

      // Auto-trigger on_status sequence after on_confirm (for Pramaan certification)
      // Sends: Packed → Agent-assigned → Order-picked-up → Out-for-delivery → Order-delivered
      // with 2s delay between each. Flows that send /cancel (3B) will interrupt naturally.
      const autoStatusSequence = async () => {
        const delay = ms => new Promise(r => setTimeout(r, ms));
        const isCancelled = () => cancelledOrders.has(order.id);

        const steps = [
          { fulfillmentState: 'Packed',            orderState: 'In-progress' },
          { fulfillmentState: 'Agent-assigned',     orderState: 'In-progress' },
          { fulfillmentState: 'Order-picked-up',    orderState: 'In-progress' },
          { fulfillmentState: 'Out-for-delivery',   orderState: 'In-progress' },
          { fulfillmentState: 'Order-delivered',    orderState: 'Completed'   },
        ];

        // Wait 15s after on_confirm for Pramaan to process /status first
        await delay(15000);

        const autoPartialCancel = process.env.ONDC_AUTO_PARTIAL_CANCEL !== 'false';

        for (const step of steps) {
          if (isCancelled()) { logger.info('Auto on_status aborted (order cancelled)', { order_id: order.id }); return; }
          // Each proactive callback must have a unique message_id (Pramaan: "message_id should be unique for each call lifecycle")
          const stepContext = { ...context, message_id: uuidv4() };
          const payload = buildStatusPayload(order.id, order, step.fulfillmentState, step.orderState, vendor);
          await sendCallback(context.bap_uri, 'on_status', stepContext, { order: payload }, tenant);
          logger.info('Auto on_status sent', { order_id: order.id, ...step });

          // Flow 3A: send on_update (Cancelled) right after Packed — Pramaan N.O. filters by Cancelled state
          if (autoPartialCancel && step.fulfillmentState === 'Packed') {
            await sendPartialCancelOnUpdate({ ...context, message_id: uuidv4() }, order, vendor, tenant, confirmUpdatedAt);
          }

          await delay(2000);
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

      if (dbOrder?.cottkart_order_id) {
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

      // Map order state → valid ONDC fulfillment state code
      const fulfillmentStateMap = {
        'Created':     'Pending',
        'Accepted':    'Pending',
        'In-progress': 'Order-picked-up',
        'Completed':   'Order-delivered',
        'Cancelled':   'Cancelled',
      };
      const fulfillmentCode = fulfillmentStateMap[currentStatus] || 'Pending';

      // Build full order object — use cached confirm order if available
      const cachedEntry = confirmedOrderCache.get(ondcOrderId) || null;
      const cachedOrder = cachedEntry?.order || null;
      const cachedVendor = cachedEntry?.vendor || null;
      const vendor = cachedVendor || (tenant.id
        ? await fetchVendorForOrder(tenant.id, cachedOrder?.provider?.id)
        : null);
      const now = new Date().toISOString();

      const baseFulfillments = cachedOrder?.fulfillments || [{ id: 'f1', type: 'Delivery' }];
      const orderPayload = {
        id:       ondcOrderId,
        state:    currentStatus,
        provider: cachedOrder?.provider,
        items:    cachedOrder?.items,
        billing:  cachedOrder?.billing,
        fulfillments: baseFulfillments.map(f =>
          buildFulfillmentWithLocation(f, vendor, fulfillmentCode, now)
        ),
        quote:     cachedOrder?.quote,
        payment: {
          ...(cachedOrder?.payment || {}),
          '@ondc/org/settlement_details': SETTLEMENT_DETAILS,
        },
        tags:       ORDER_TAGS,
        created_at: cachedOrder?.created_at || now,
        updated_at: cachedOrder?.updated_at || now,
      };

      await sendCallback(context.bap_uri, 'on_status', context, {
        order: orderPayload,
      }, tenant);
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

    // Signal auto-sequence to stop for this order
    if (order_id) cancelledOrders.add(order_id);

    ack(res, context);

    const tenant = await getTenantByBppId(context?.bpp_id);
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

      const cachedEntry = confirmedOrderCache.get(order_id) || null;
      const cachedOrder = cachedEntry?.order || null;
      const cachedVendor = cachedEntry?.vendor || null;
      const now = new Date().toISOString();

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
          '@ondc/org/settlement_details':           SETTLEMENT_DETAILS,
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

        // Build return fulfillment helper
        const buildReturnFulfillment = (returnState) => ({
          id: 'r1',
          type: 'Return',
          state: { descriptor: { code: returnState } },
          '@ondc/org/provider_name': providerName,
          tags: [{
            code: 'return_request',
            list: [
              { code: 'id', value: 'r1' },
              { code: 'item_id', value: (fullOrder.items?.[0]?.id || '') },
              { code: 'parent_item_id', value: (fullOrder.items?.[0]?.parent_item_id || fullOrder.items?.[0]?.id || 'N/A') },
              { code: 'item_quantity', value: String(fullOrder.items?.[0]?.quantity?.count || 1) },
              { code: 'reason_id', value: '001' },
              { code: 'reason_desc', value: 'detailed description for return' },
              { code: 'images', value: 'https://ondc.cottkart.com/placeholder.png' },
              { code: 'ttl_approval', value: 'PT24H' },
              { code: 'ttl_reverseqc', value: 'P3D' },
            ],
          }],
        });

        const buildReturnPayload = (returnState) => {
          const deliveryFulfillments = (confirmedOrder.fulfillments || [{ id: 'f1', type: 'Delivery' }]).map(f =>
            buildFulfillmentWithLocation(f, vendor, 'Order-delivered', now)
          );
          return {
            id:       fullOrder.id,
            state:    'Completed',
            provider: fullOrder.provider,
            items:    fullOrder.items,
            billing:  fullOrder.billing,
            fulfillments: [...deliveryFulfillments, buildReturnFulfillment(returnState)],
            quote:    fullOrder.quote,
            payment:  { ...(fullOrder.payment || {}), status: 'PAID' },
            tags:     ORDER_TAGS,
            created_at: fullOrder.created_at || now,
            updated_at: confirmTimestamp || confirmedOrder.updated_at || now,
          };
        };

        // payment = Flow 3A settlement ACK only; fulfillment/item = Flow 4A/4B return sequence
        const delay = ms => new Promise(r => setTimeout(r, ms));

        if (update_target === 'payment') {
          logger.info('handleUpdate payment: ACK only (Flow 3A settlement)', { order_id: order.id });

        } else if (update_target === 'fulfillment' || update_target === 'item') {
          // Return request — send full return sequence
          const returnSteps = ['Return_Initiated', 'Return_Approved', 'Return_Picked', 'Return_Delivered'];
          for (const returnState of returnSteps) {
            const payload = buildReturnPayload(returnState);
            await sendCallback(fullContext.bap_uri, 'on_update', fullContext, { order: payload }, tenant);
            logger.info(`on_update (${returnState}) sent OK`, { order_id: fullOrder.id });
            if (returnState !== 'Return_Delivered') await delay(2000);
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

    const { order, context, vendor: cachedVendor } = cachedEntry;
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
      steps = ['Return_Rejected'];
    } else if (state) {
      steps = [state];
    } else {
      return res.status(400).json({ error: 'Provide type (4a/4b) or state in body' });
    }

    // Respond immediately, send callbacks in background
    res.json({ success: true, message: `on_update return sequence started`, steps, order_id });

    const providerName = vendor?.business_name || order.provider?.descriptor?.name || '';
    // Separate delivery and return fulfillments from cached order
    const deliveryFulfillments = (order.fulfillments || []).filter(f => f.type !== 'Return');
    const returnFulfillments = (order.fulfillments || []).filter(f => f.type === 'Return');

    const delay = ms => new Promise(r => setTimeout(r, ms));
    for (const returnState of steps) {
      const now = new Date().toISOString();
      const returnPayload = {
        id:    order_id,
        state: 'Completed',
        provider:  order.provider,
        items:     order.items,
        billing:   order.billing,
        quote:     order.quote,
        payment:   order.payment,
        fulfillments: [
          // Delivery fulfillment(s) with full start/end location
          ...(deliveryFulfillments.length > 0
            ? deliveryFulfillments
            : [{ id: 'f1', type: 'Delivery' }]
          ).map(f => buildFulfillmentWithLocation(f, vendor, 'Order-delivered', now)),
          // Return fulfillment(s) with id + provider_name
          ...returnFulfillments.map((f, idx) => ({
            ...f,
            id:   f.id || `r${idx + 1}`,
            type: f.type || 'Return',
            state: { descriptor: { code: returnState } },
            '@ondc/org/provider_name': f['@ondc/org/provider_name'] || providerName,
          })),
        ],
        created_at: order.created_at || now,
        updated_at: now,
      };

      // Push N.O. log before HTTP callback
      const onUpdatePayload = {
        context: {
          ...context,
          action: 'on_update',
          bpp_id:  process.env.ONDC_SUBSCRIBER_ID || context.bpp_id,
          bpp_uri: process.env.ONDC_SUBSCRIBER_URL || context.bpp_uri,
          timestamp: new Date().toISOString(),
          message_id: uuidv4(),
          ttl: 'PT30S',
        },
        message: { order: returnPayload },
      };
      pushTxnLog('on_update', onUpdatePayload).catch(e =>
        logger.warn(`N.O. on_update push failed for ${returnState}:`, e.message)
      );

      try {
        await sendCallback(context.bap_uri, 'on_update', { ...context, message_id: uuidv4() }, { order: returnPayload }, tenant);
        logger.info('on_update (return state) sent', { order_id, returnState });
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

    const now = new Date().toISOString();
    const cancelFulfillmentTags = [{ code: 'cancellation_terms', list: [{ code: 'reason_required', value: 'false' }] }];
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
        '@ondc/org/settlement_details':           SETTLEMENT_DETAILS,
        status: 'PAID',
      },
      cancellation: {
        cancelled_by: 'SELLER',
        reason: { id: reason_id },
        ...(rto ? { return_reason: { id: reason_id } } : {}),
      },
      fulfillments: (order.fulfillments || []).map(f => ({
        ...buildFulfillmentWithLocation(f, cachedVendor, rto ? 'RTO-Initiated' : 'Cancelled', now),
        tags: cancelFulfillmentTags,
      })),
      created_at:  order.created_at || now,
      updated_at:  now,
    };

    await sendCallback(context.bap_uri, 'on_cancel', { ...context, message_id: uuidv4() }, { order: cancelPayload }, tenant);
    logger.info('Merchant on_cancel sent', { order_id, reason_id, rto });
    res.json({ success: true, message: 'on_cancel sent', order_id });
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

    const { order, context } = cachedEntry;
    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const fulfillmentState = req.body?.state || 'Pending';
    const orderState       = req.body?.order_state || 'Accepted';

    const now = new Date().toISOString();
    const statusPayload = {
      id:           order_id,
      state:        orderState,
      provider:     order.provider,
      items:        order.items,
      billing:      order.billing,
      fulfillments: (order.fulfillments || []).map(f => ({
        ...f,
        state: { descriptor: { code: fulfillmentState } },
        tracking: false,
      })),
      quote:        order.quote,
      payment:      order.payment,
      created_at:   order.created_at || now,
      updated_at:   now,
    };

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
  return {
    id:       order_id,
    state:    orderState,
    provider: order.provider,
    items:    order.items,
    billing:  order.billing,
    fulfillments: (order.fulfillments || [{ id: 'f1', type: 'Delivery' }]).map(f =>
      buildFulfillmentWithLocation(f, vendor, fulfillmentState, now)
    ),
    quote:     order.quote,
    payment: {
      ...order.payment,
      '@ondc/org/settlement_details': SETTLEMENT_DETAILS,
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
      'rto_delivered': [
        { fulfillmentState: 'RTO-Delivered', orderState: 'Cancelled' },
      ],
    };

    const steps = sequences[type];
    if (!steps) return res.status(400).json({ error: `Unknown type: ${type}. Use 3a, 3b, or rto_delivered` });

    // Respond immediately, send callbacks in background
    res.json({ success: true, message: `on_status sequence (${type}) started`, steps: steps.length, order_id });

    // Send each state with 2s delay
    const delay = ms => new Promise(r => setTimeout(r, ms));
    for (const step of steps) {
      const payload = buildStatusPayload(order_id, order, step.fulfillmentState, step.orderState, vendor);
      await sendCallback(context.bap_uri, 'on_status', { ...context, message_id: uuidv4() }, { order: payload }, tenant);
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

const handleIssue = async (req, res) => {
  try {
    const body    = req.body;
    const context = body.context;
    const issue   = body.message?.issue || {};
    logger.info('ONDC /issue received', { transaction_id: context?.transaction_id });

    ack(res, context);

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return;

    const issueId = issue.id || uuidv4();
    const issueStatus = issue.status;

    // If issue status is CLOSED, just ACK — no on_issue callback (per PDF §11.12)
    if (issueStatus === 'CLOSED') {
      logger.info('Issue CLOSED received — ACK only', { issue_id: issueId });
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

    // Check if this is a subsequent /issue call (info shared or resolution selected)
    const cached = issueCache.get(issueId);
    const stage  = cached?.stage || 0;
    const now    = new Date().toISOString();
    const updatedBy = {
      org:     { name: tenant.subscriber_id },
      contact: { phone: process.env.SUPPORT_PHONE || '', email: process.env.SUPPORT_EMAIL || '' },
      person:  { name: 'Support Desk' },
    };

    if (stage === 0) {
      // First /issue — send PROCESSING, then auto-send NEED-MORE-INFO after 2s
      issueCache.set(issueId, { issue, context, tenant, stage: 1 });
      lastIssueId = issueId;
      logger.info('Cached issue (stage 0→1)', { issue_id: issueId });

      await sendCallback(context.bap_uri, 'on_issue', context, {
        issue: {
          id: issueId,
          issue_actions: {
            respondent_actions: [{
              respondent_action: 'PROCESSING',
              short_desc:        'Issue received and being processed',
              updated_at:        now,
              updated_by:        updatedBy,
            }],
          },
          created_at: now, updated_at: now, status: 'OPEN',
        },
      }, tenant);

      // Auto-chain: NEED-MORE-INFO (2s) → Resolution Options (5s)
      const autoChain = async () => {
        try {
          // Step 2: NEED-MORE-INFO
          await new Promise(r => setTimeout(r, 2000));
          await sendCallback(context.bap_uri, 'on_issue', context, {
            issue: {
              id: issueId,
              issue_actions: {
                respondent_actions: [{
                  respondent_action: 'PROCESSING',
                  short_desc:        'Issue received and being processed',
                  updated_at:        now,
                  updated_by:        updatedBy,
                }, {
                  respondent_action: 'NEED-MORE-INFO',
                  short_desc:        'Please share additional details about the issue',
                  updated_at:        new Date().toISOString(),
                  updated_by:        updatedBy,
                }],
              },
              created_at: now, updated_at: new Date().toISOString(), status: 'OPEN',
            },
          }, tenant);
          logger.info('on_issue (NEED-MORE-INFO) sent', { issue_id: issueId });

          // Step 3: Resolution Options (after 3s more)
          await new Promise(r => setTimeout(r, 3000));
          const resAction = issueCache.get(issueId)?.resolveAction || 'REFUND';
          await sendCallback(context.bap_uri, 'on_issue', context, {
            issue: {
              id: issueId,
              issue_actions: {
                respondent_actions: [{
                  respondent_action: 'PROCESSING',
                  short_desc:        'Issue received and being processed',
                  updated_at:        now,
                  updated_by:        updatedBy,
                }, {
                  respondent_action: 'NEED-MORE-INFO',
                  short_desc:        'Please share additional details',
                  updated_at:        now,
                  updated_by:        updatedBy,
                }, {
                  respondent_action: 'RESOLVED',
                  short_desc:        `${resAction} - Issue resolved with ${resAction.toLowerCase()}`,
                  updated_at:        new Date().toISOString(),
                  updated_by:        updatedBy,
                }],
              },
              resolution: {
                short_desc:        `${resAction} - Issue resolved`,
                long_desc:         `Issue has been resolved with ${resAction.toLowerCase()}`,
                action_triggered:  resAction,
                refund_amount:     '0.00',
              },
              resolution_provider: {
                respondent_info: updatedBy,
              },
              created_at: now, updated_at: new Date().toISOString(), status: 'RESOLVED',
            },
          }, tenant);
          issueCache.set(issueId, { ...issueCache.get(issueId), stage: 2 });
          logger.info('on_issue (resolution options) auto-sent', { issue_id: issueId, resAction });
        } catch (err) {
          logger.error('on_issue auto-chain failed:', err.message);
        }
      };
      autoChain();

    } else if (stage === 1) {
      // Second /issue — buyer shared info → send on_issue with resolution options
      issueCache.set(issueId, { ...cached, stage: 2 });
      logger.info('Issue info received (stage 1→2), sending resolution options', { issue_id: issueId });

      const resolutionAction = issueCache.get(issueId)?.resolveAction || 'REFUND';
      await sendCallback(context.bap_uri, 'on_issue', context, {
        issue: {
          id: issueId,
          issue_actions: {
            respondent_actions: [{
              respondent_action: 'PROCESSING',
              short_desc:        'Issue received and being processed',
              updated_at:        now,
              updated_by:        updatedBy,
            }, {
              respondent_action: 'NEED-MORE-INFO',
              short_desc:        'Please share additional details',
              updated_at:        now,
              updated_by:        updatedBy,
            }, {
              respondent_action: 'RESOLVED',
              short_desc:        `Issue resolved with ${resolutionAction.toLowerCase()}`,
              updated_at:        now,
              updated_by:        updatedBy,
            }],
          },
          resolution: {
            short_desc:        `${resolutionAction} - Issue resolved`,
            long_desc:         `Issue has been resolved with ${resolutionAction.toLowerCase()}`,
            action_triggered:  resolutionAction,
            refund_amount:     '0.00',
          },
          resolution_provider: {
            respondent_info: updatedBy,
          },
          created_at: now, updated_at: now, status: 'RESOLVED',
        },
      }, tenant);
      logger.info('on_issue (resolution options) sent', { issue_id: issueId });

    } else {
      // Stage 2+ — buyer selected resolution, just ACK (already sent above)
      logger.info('Issue resolution selected — ACK only', { issue_id: issueId, stage });
    }
  } catch (err) {
    logger.error('handleIssue failed:', err.message);
  }
};

const handleIssueStatus = async (req, res) => {
  try {
    const body     = req.body;
    const context  = body.context;
    const issue_id = body.message?.issue_id;
    logger.info('ONDC /issue_status received', { issue_id });

    ack(res, context);

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return;

    let issueStatus = 'OPEN';
    let resolution  = null;
    try {
      const [rows] = await pool.query(
        `SELECT * FROM issue_grievances WHERE issue_id = ? AND tenant_id = ?`,
        [issue_id, tenant.id]
      );
      if (rows.length) {
        issueStatus = (rows[0].status || 'open').toUpperCase();
        resolution  = rows[0].resolution;
      }
    } catch (e) {}

    await sendCallback(context.bap_uri, 'on_issue_status', context, {
      issue: {
        id: issue_id,
        issue_actions: {
          respondent_actions: [{
            respondent_action: issueStatus === 'RESOLVED' ? 'RESOLVED' : 'PROCESSING',
            short_desc:        resolution || 'Being processed',
            updated_at:        new Date().toISOString(),
          }],
        },
        status:     issueStatus,
        updated_at: new Date().toISOString(),
      },
    }, tenant);
  } catch (err) {
    logger.error('handleIssueStatus failed:', err.message);
  }
};

// triggerIssueResolve — sends proactive on_issue_status with RESOLVED
// Body: { action: 'REFUND' | 'REPLACEMENT' | 'CANCEL' | 'NO_ACTION', short_desc?: string }
const triggerIssueResolve = async (req, res) => {
  try {
    const rawId = req.params.issue_id;
    const issue_id = rawId === 'latest' ? lastIssueId : rawId;
    if (!issue_id) return res.status(404).json({ error: 'No issue in cache' });

    const cached = issueCache.get(issue_id);
    if (!cached) return res.status(404).json({ error: 'Issue not found in cache' });

    const { context, tenant } = cached;
    const action    = req.body?.action || 'REFUND';
    const shortDesc = req.body?.short_desc || `Issue resolved with ${action.toLowerCase()}`;

    // Pre-set resolve action in cache for on_issue resolution options
    issueCache.set(issue_id, { ...cached, resolveAction: action });

    const now = new Date().toISOString();

    await sendCallback(context.bap_uri, 'on_issue_status', context, {
      issue: {
        id: issue_id,
        issue_actions: {
          respondent_actions: [
            {
              respondent_action: 'PROCESSING',
              short_desc:        'Issue received and being processed',
              updated_at:        now,
              updated_by: {
                org:     { name: tenant.subscriber_id },
                contact: {
                  phone: process.env.SUPPORT_PHONE || '',
                  email: process.env.SUPPORT_EMAIL || '',
                },
              },
            },
            {
              respondent_action: 'RESOLVED',
              short_desc:        shortDesc,
              updated_at:        now,
              updated_by: {
                org:     { name: tenant.subscriber_id },
                contact: {
                  phone: process.env.SUPPORT_PHONE || '',
                  email: process.env.SUPPORT_EMAIL || '',
                },
              },
            },
          ],
        },
        resolution: {
          short_desc:    shortDesc,
          long_desc:     shortDesc,
          action_triggered: action,
          refund_amount: '0.00',
        },
        created_at: now,
        updated_at: now,
        status:     'RESOLVED',
      },
    }, tenant);

    logger.info('Proactive on_issue_status (RESOLVED) sent', { issue_id, action });
    res.json({ success: true, message: `on_issue_status RESOLVED sent`, issue_id, action });
  } catch (err) {
    logger.error('triggerIssueResolve failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// Generic ACK for ONDC callbacks we receive (on_*)
const handleACK = (action) => async (req, res) => {
  logger.info(`ONDC /${action} received`);
  const context = req.body?.context;
  const body = buildAckBody(context);
  pushTxnLog(`${action}_response`, body).catch(() => {});
  res.json(body);
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
  handleIssue,
  handleIssueStatus,
  handleACK,
  triggerIssueResolve,
  triggerMerchantUpdate,
  triggerMerchantReturnUpdate,
  triggerMerchantCancel,
  triggerMerchantStatus,
  triggerMerchantStatusSequence,
};
