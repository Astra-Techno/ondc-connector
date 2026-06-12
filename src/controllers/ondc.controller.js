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
} = require('../services/ondc/order.service');
const cottKartOrder = require('../services/cloudkart/order.service');

// In-memory cache: order_id → { order, context } (for on_status/on_update/on_cancel callbacks)
const confirmedOrderCache = new Map();
let lastConfirmedOrderId = null; // track most recent for /latest shortcut

// In-memory cache: issue_id → { issue, context } (for proactive on_issue_status)
const issueCache = new Map();
let lastIssueId = null;

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
    // Filter vendors by city: include nationwide vendors (std_city_code IS NULL)
    // and vendors whose city code matches the searched city
    const [vendors] = await pool.query(
      `SELECT * FROM vendors WHERE tenant_id = ? AND status = 'active'
       AND (std_city_code IS NULL OR ? IS NULL OR std_city_code = ?)`,
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

      const items = products.map(p => ({
        id: p.external_product_id,
        descriptor: {
          name:       p.name,
          code:       `5:${p.external_product_id}`,
          short_desc: p.short_description || p.name,
          long_desc:  p.description       || p.name,
          images:     p.images ? JSON.parse(p.images).map(url => ({ url }))
                               : p.image_url ? [{ url: p.image_url }] : [],
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
      }));

      providers.push({
        id: vendor.external_vendor_id || String(vendor.id),
        descriptor: {
          name:       vendor.business_name,
          short_desc: vendor.business_name,
          images:     vendor.logo_url ? [{ url: vendor.logo_url }] : [],
        },
        ttl: 'P1D',
        '@ondc/org/fssai_license_no': vendor.fssai_number || '',
        categories: [
          { id: 'Grocery', descriptor: { name: 'Grocery' } },
        ],
        locations: [{
          id:  'l1',
          gps: vendor.gps || '13.0827,80.2707',
          address: {
            locality:  vendor.address || vendor.city,
            city:      vendor.city    || 'Chennai',
            state:     vendor.state   || 'Tamil Nadu',
            country:   'IND',
            area_code: vendor.pincode || '600001',
          },
          time: {
            label:     'enable',
            timestamp: new Date().toISOString(),
            days:      '1,2,3,4,5,6,7',
            schedule:  { holidays: [] },
            range:     { start: '0900', end: '2100' },
          },
          circle: {
            gps:    vendor.gps || '13.0827,80.2707',
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
            short_desc: 'ONDC Seller Platform',
            long_desc:  'Multi-vendor ONDC Seller Platform powered by CottKart',
            images:     [],
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

// Send on_search callback (signed)
const sendOnSearch = async (context, catalog, ondcConfig) => {
  const callbackUrl = context.bap_uri ? `${context.bap_uri}/on_search` : null;
  try {
    const { createAuthHeader } = require('../utils/crypto');
    if (!callbackUrl) { logger.warn('on_search: no bap_uri in context'); return; }
    const payload = {
      context: {
        ...context,
        action:    'on_search',
        bpp_id:    ondcConfig?.subscriber_id,
        bpp_uri:   ondcConfig?.subscriber_url,
        timestamp: new Date().toISOString(),
        // message_id must match the search request's message_id (Beckn protocol)
        ttl:       'PT30S',
      },
      message: { catalog },
    };

    const headers = { 'Content-Type': 'application/json' };
    if (ondcConfig?.signing_private_key) {
      try {
        headers['Authorization'] = createAuthHeader(
          ondcConfig.signing_private_key,
          ondcConfig.subscriber_id,
          ondcConfig.unique_key_id,
          payload
        );
      } catch (e) {
        logger.warn('on_search auth header skipped:', e.message);
      }
    }

    logger.info(`Sending on_search → ${callbackUrl}`);
    const response = await axios.post(callbackUrl, payload, { headers, timeout: 10000 });
    logger.info(`on_search sent to ${callbackUrl}: ${response.status}`);
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

    res.json({ message: { ack: { status: 'ACK' } } });

    // Only respond to grocery domain — our catalog is ONDC:RET10
    if (context?.domain && context.domain !== 'ONDC:RET10') {
      logger.info(`Ignoring /search for unsupported domain: ${context.domain}`);
      return;
    }

    const tenants = await getActiveTenants();
    if (!tenants.length) { logger.info('No active tenants for /search'); return; }

    for (const tenant of tenants) {
      const ondcConfig = {
        subscriber_id:       tenant.subscriber_id,
        subscriber_url:      tenant.subscriber_url,
        signing_private_key: tenant.signing_private_key,
        unique_key_id:       tenant.unique_key_id,
      };
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
  try {
    const body    = req.body;
    const context = body.context;
    logger.info('ONDC /select received', { transaction_id: context?.transaction_id });

    res.json({ message: { ack: { status: 'ACK' } } });

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) { logger.warn('/select: no tenant found'); return; }

    const order       = body.message?.order || {};
    const items       = order.items         || [];
    const fulfillments = order.fulfillments || [];

    try {
      const { quote, outOfStockItems } = await buildQuote(items, tenant.id);

      const payload = {
        order: {
          provider: order.provider,
          items,
          quote,
          fulfillments: fulfillments.map(f => ({
            ...f,
            '@ondc/org/TAT': 'PT24H',
            tracking: false,
          })),
        },
      };

      // Add error for out-of-stock items (ONDC error code 40002)
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
    }
  } catch (err) {
    logger.error('handleSelect failed:', err.message);
  }
};

const handleInit = async (req, res) => {
  try {
    const body    = req.body;
    const context = body.context;
    logger.info('ONDC /init received', { transaction_id: context?.transaction_id });

    res.json({ message: { ack: { status: 'ACK' } } });

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return;

    const order = body.message?.order || {};
    const items = order.items         || [];

    try {
      const { quote } = await buildQuote(items, tenant.id);
      const orderObj = buildOrderObject(context, body.message, 'Created', quote, tenant);

      await sendCallback(context.bap_uri, 'on_init', context, {
        order: {
          ...orderObj,
          payment: {
            ...order.payment,
            '@ondc/org/buyer_app_finder_fee_type':   'percent',
            '@ondc/org/buyer_app_finder_fee_amount': '3',
            type: 'ON-ORDER',
          },
        },
      }, tenant);
    } catch (err) {
      logger.error('handleInit processing failed:', err.message);
    }
  } catch (err) {
    logger.error('handleInit failed:', err.message);
  }
};

const handleConfirm = async (req, res) => {
  try {
    const body    = req.body;
    const context = body.context;
    logger.info('ONDC /confirm received', { transaction_id: context?.transaction_id });

    res.json({ message: { ack: { status: 'ACK' } } });

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return;

    const order = body.message?.order || {};

    // Cache order + context (for on_status, on_update, on_cancel callbacks)
    if (order.id) {
      confirmedOrderCache.set(order.id, { order, context });
      lastConfirmedOrderId = order.id;
      logger.info('Cached confirmed order', { order_id: order.id });
    }

    try {
      // 1. Save to DB
      await saveONDCOrder(tenant.id, body, body);

      // 2. Push to CottKart
      let cottKartOrderId = null;
      try {
        const ckResult = await cottKartOrder.pushOrder(body);
        cottKartOrderId = ckResult?.id || ckResult?.order_id;
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
      const quote    = await buildQuote(order.items || [], tenant.id).then(r => r.quote).catch(() => order.quote);
      const orderObj = buildOrderObject(context, body.message, 'Created', quote, tenant);

      await sendCallback(context.bap_uri, 'on_confirm', context, {
        order: {
          ...orderObj,
          id:      order.id,
          payment: { ...order.payment, status: 'PAID' },
        },
      }, tenant);
    } catch (err) {
      logger.error('handleConfirm processing failed:', err.message);
    }
  } catch (err) {
    logger.error('handleConfirm failed:', err.message);
  }
};

const handleStatus = async (req, res) => {
  try {
    const body       = req.body;
    const context    = body.context;
    const ondcOrderId = body.message?.order_id;
    logger.info('ONDC /status received', { order_id: ondcOrderId });

    res.json({ message: { ack: { status: 'ACK' } } });

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return;

    try {
      const [rows] = await pool.query(
        `SELECT * FROM ondc_orders WHERE ondc_order_id = ? AND tenant_id = ?`,
        [ondcOrderId, tenant.id]
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
      const now = new Date().toISOString();

      const orderPayload = cachedOrder ? {
        id:           ondcOrderId,
        state:        currentStatus,
        provider:     cachedOrder.provider,
        items:        cachedOrder.items,
        billing:      cachedOrder.billing,
        fulfillments: (cachedOrder.fulfillments || []).map(f => ({
          ...f,
          state: { descriptor: { code: fulfillmentCode } },
          tracking: false,
        })),
        quote:        cachedOrder.quote,
        payment:      cachedOrder.payment,
        created_at:   cachedOrder.created_at || now,
        updated_at:   now,
      } : {
        id:    ondcOrderId,
        state: currentStatus,
        fulfillments: [{
          id: 'f1', type: 'Delivery',
          state: { descriptor: { code: fulfillmentCode } },
          tracking: false,
        }],
        updated_at: now,
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
    const context = body.context;
    const { order_id, cancellation_reason_id } = body.message || {};
    logger.info('ONDC /cancel received', { order_id });

    res.json({ message: { ack: { status: 'ACK' } } });

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
      const now = new Date().toISOString();

      const cancelPayload = cachedOrder ? {
        id:    order_id,
        state: 'Cancelled',
        provider:  cachedOrder.provider,
        items:     cachedOrder.items,
        billing:   cachedOrder.billing,
        quote:     cachedOrder.quote,
        payment:   cachedOrder.payment,
        cancellation: {
          cancelled_by: 'CONSUMER',
          reason: { id: cancellation_reason_id || '001' },
        },
        fulfillments: (cachedOrder.fulfillments || []).map(f => ({
          ...f,
          state: { descriptor: { code: 'Cancelled' } },
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
        fulfillments: [{ id: 'f1', state: { descriptor: { code: 'Cancelled' } } }],
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
// Flow 4A/4B (return):  update_target = 'fulfillment' → ACK + on_update (Return_Initiated)
const handleUpdate = async (req, res) => {
  try {
    const body          = req.body;
    const context       = body.context;
    const order         = body.message?.order || {};
    const update_target = body.message?.update_target || '';
    logger.info('ONDC /update received', { transaction_id: context?.transaction_id, order_id: order.id, update_target });

    // Always ACK first
    res.json({ message: { ack: { status: 'ACK' } } });

    // For return updates (fulfillment target), send on_update with Return_Initiated
    if (update_target === 'fulfillment') {
      try {
        const tenant = await getTenantByBppId(context?.bpp_id);
        if (!tenant) return;

        const now = new Date().toISOString();
        const returnPayload = {
          id:    order.id,
          state: 'Completed',
          provider:  order.provider,
          items:     order.items,
          billing:   order.billing,
          quote:     order.quote,
          payment:   order.payment,
          fulfillments: (order.fulfillments || []).map(f => ({
            ...f,
            state: { descriptor: { code: 'Return_Initiated' } },
          })),
          created_at: order.created_at || now,
          updated_at: now,
        };

        await sendCallback(context.bap_uri, 'on_update', context, { order: returnPayload }, tenant);
        logger.info('on_update (Return_Initiated) sent', { order_id: order.id });

        // Cache the order for subsequent return trigger calls
        if (order.id) {
          confirmedOrderCache.set(order.id, { order, context });
          lastConfirmedOrderId = order.id;
        }
      } catch (err) {
        logger.error('handleUpdate return callback failed:', err.message);
      }
    }
    // For settlement updates (payment target) — ACK only, no callback
  } catch (err) {
    logger.error('handleUpdate failed:', err.message);
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
    const { order, context } = cachedEntry;
    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // Partial cancel: mark first item as cancelled, keep rest
    const allItems = order.items || [];
    const cancelledItem = allItems[0];
    const remainingItems = allItems.slice(1);

    // Recalculate quote — remove cancelled item price from total
    const originalBreakup = order.quote?.breakup || [];
    const updatedBreakup = originalBreakup.filter(b =>
      !(b['@ondc/org/title_type'] === 'item' && b['@ondc/org/item_id'] === cancelledItem?.id)
    );
    const updatedTotal = updatedBreakup
      .reduce((sum, b) => sum + parseFloat(b.price?.value || 0), 0)
      .toFixed(2);

    const now = new Date().toISOString();

    const updatePayload = {
      id:    order_id,
      state: 'Accepted',
      provider: order.provider,
      items: [
        ...(remainingItems.length ? remainingItems : allItems).map(i => ({ ...i })),
        ...(cancelledItem ? [{ ...cancelledItem, tags: [{ code: 'cancellation', list: [{ code: 'reason_id', value: '001' }] }] }] : []),
      ],
      billing:  order.billing,
      quote: {
        price: { currency: 'INR', value: updatedTotal },
        breakup: updatedBreakup,
        ttl: order.quote?.ttl || 'P1D',
      },
      payment:  order.payment,
      fulfillments: (order.fulfillments || []).map(f => ({
        ...f,
        state: { descriptor: { code: 'Pending' } },
      })),
      created_at:  order.created_at || now,
      updated_at:  now,
      tags: [{ code: 'cancellation_initiated_by', list: [{ code: 'reason_id', value: '001' }] }],
    };

    await sendCallback(context.bap_uri, 'on_update', context, { order: updatePayload }, tenant);
    logger.info('Merchant on_update sent', { order_id });
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

    const { order, context } = cachedEntry;
    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

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
        fulfillments: (order.fulfillments || []).map(f => ({
          ...f,
          state: { descriptor: { code: returnState } },
        })),
        created_at: order.created_at || now,
        updated_at: now,
      };
      await sendCallback(context.bap_uri, 'on_update', context, { order: returnPayload }, tenant);
      logger.info('on_update (return state) sent', { order_id, returnState });
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
    const { order, context } = cachedEntry;
    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const now = new Date().toISOString();
    const cancelPayload = {
      id:    order_id,
      state: 'Cancelled',
      provider:  order.provider,
      items:     order.items,
      billing:   order.billing,
      quote:     order.quote,
      payment:   order.payment,
      cancellation: {
        cancelled_by: 'SELLER',
        reason: { id: reason_id },
        ...(rto ? { return_reason: { id: reason_id } } : {}),
      },
      fulfillments: (order.fulfillments || []).map(f => ({
        ...f,
        state: { descriptor: { code: rto ? 'RTO-Initiated' : 'Cancelled' } },
      })),
      created_at:  order.created_at || now,
      updated_at:  now,
    };

    await sendCallback(context.bap_uri, 'on_cancel', context, { order: cancelPayload }, tenant);
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

    await sendCallback(context.bap_uri, 'on_status', context, { order: statusPayload }, tenant);
    logger.info('Proactive on_status sent', { order_id, fulfillmentState, orderState });
    res.json({ success: true, message: 'on_status sent', order_id, state: fulfillmentState });
  } catch (err) {
    logger.error('triggerMerchantStatus failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// Helper: build an on_status payload for a given fulfillment state + order state
const buildStatusPayload = (order_id, order, fulfillmentState, orderState) => {
  const now = new Date().toISOString();
  return {
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

    const { order, context } = cachedEntry;
    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

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
      const payload = buildStatusPayload(order_id, order, step.fulfillmentState, step.orderState);
      await sendCallback(context.bap_uri, 'on_status', context, { order: payload }, tenant);
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

    res.json({ message: { ack: { status: 'ACK' } } });

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return;

    try {
      const [rows] = await pool.query(
        `SELECT * FROM ondc_orders WHERE ondc_order_id = ? AND tenant_id = ?`,
        [order_id, tenant.id]
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

      await sendCallback(context.bap_uri, 'on_track', context, {
        tracking: {
          id:     order_id,
          url:    trackingUrl || `${tenant.subscriber_url}/track/${order_id}`,
          status: trackingStatus,
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

    res.json({ message: { ack: { status: 'ACK' } } });

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

    res.json({ message: { ack: { status: 'ACK' } } });

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

    res.json({ message: { ack: { status: 'ACK' } } });

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

    res.json({ message: { ack: { status: 'ACK' } } });

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
  res.json({ message: { ack: { status: 'ACK' } } });
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
