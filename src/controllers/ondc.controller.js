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
         WHERE tenant_id = ? AND vendor_id = ? AND is_active = 1 AND stock > 0
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
          available: { count: (p.stock > 0) ? '99' : '0' },
          maximum:   { count: '99' },
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
      const quote = await buildQuote(items, tenant.id);
      await sendCallback(context.bap_uri, 'on_select', context, {
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
      }, tenant);
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
      const quote    = await buildQuote(items, tenant.id);
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
      const quote    = await buildQuote(order.items || [], tenant.id).catch(() => order.quote);
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
const handleUpdate = async (req, res) => {
  try {
    const body    = req.body;
    const context = body.context;
    const order   = body.message?.order || {};
    logger.info('ONDC /update received', { transaction_id: context?.transaction_id, order_id: order.id });

    res.json({ message: { ack: { status: 'ACK' } } });

    const tenant = await getTenantByBppId(context?.bpp_id);
    if (!tenant) return;

    try {
      // Retrieve cached confirmed order for full payload
      const cachedEntry = confirmedOrderCache.get(order.id) || null;
      const cachedOrder = cachedEntry?.order || order;
      const now = new Date().toISOString();

      // Echo back on_update with current order state + updated payment if provided
      const updatePayload = {
        id:          order.id || cachedOrder.id,
        state:       cachedOrder.state || 'Accepted',
        provider:    cachedOrder.provider,
        items:       cachedOrder.items,
        billing:     cachedOrder.billing,
        fulfillments: (cachedOrder.fulfillments || []).map(f => ({
          ...f,
          state: { descriptor: { code: 'Pending' } },
        })),
        quote:   order.quote   || cachedOrder.quote,
        payment: order.payment || cachedOrder.payment,
        created_at: cachedOrder.created_at || now,
        updated_at: now,
      };

      await sendCallback(context.bap_uri, 'on_update', context, { order: updatePayload }, tenant);
      logger.info('on_update sent (from /update request)', { order_id: order.id });
    } catch (err) {
      logger.error('handleUpdate processing failed:', err.message);
    }
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

// triggerMerchantStatus — proactively send on_status (for flows that need it unsolicited)
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

    const now = new Date().toISOString();
    const statusPayload = {
      id:           order_id,
      state:        'Accepted',
      provider:     order.provider,
      items:        order.items,
      billing:      order.billing,
      fulfillments: (order.fulfillments || []).map(f => ({
        ...f,
        state: { descriptor: { code: 'Pending' } },
        tracking: false,
      })),
      quote:        order.quote,
      payment:      order.payment,
      created_at:   order.created_at || now,
      updated_at:   now,
    };

    await sendCallback(context.bap_uri, 'on_status', context, { order: statusPayload }, tenant);
    logger.info('Proactive on_status sent', { order_id });
    res.json({ success: true, message: 'on_status sent', order_id });
  } catch (err) {
    logger.error('triggerMerchantStatus failed:', err.message);
    res.status(500).json({ error: err.message });
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
        issue.order_details?.id,
        issue.issue_type  || 'FULFILLMENT',
        issue.category,
        issue.sub_category,
        issue.description,
        issue.complainant_info?.person?.name,
        issue.complainant_info?.contact?.phone,
        issue.complainant_info?.contact?.email,
        JSON.stringify(body),
      ]);
    } catch (e) {
      logger.warn('Issue save failed:', e.message);
    }

    await sendCallback(context.bap_uri, 'on_issue', context, {
      issue: {
        id: issueId,
        issue_actions: {
          respondent_actions: [{
            respondent_action: 'PROCESSING',
            short_desc:        'Issue received and being processed',
            updated_at:        new Date().toISOString(),
            updated_by: {
              org:     { name: tenant.subscriber_id },
              contact: {
                phone: process.env.SUPPORT_PHONE || '',
                email: process.env.SUPPORT_EMAIL || '',
              },
            },
          }],
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status:     'OPEN',
      },
    }, tenant);
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
  triggerMerchantUpdate,
  triggerMerchantCancel,
  triggerMerchantStatus,
};
