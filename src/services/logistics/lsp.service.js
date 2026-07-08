// On-Network Logistics — LBNP (Logistics Buyer NP) outbound calls
// Flow A1: retail /confirm → /search gateway → on_search → /init LSP → on_init → /confirm LSP
// Callbacks (on_search, on_init, on_confirm, on_status) are handled in logistics.controller.js

const axios  = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../utils/logger');
const { createAuthHeader } = require('../../utils/crypto');
const { resolveOndcConfig }  = require('../ondc/order.service');

const LOGISTICS_DOMAIN  = 'nic2004:60232';
const LOGISTICS_VERSION = '1.2.0';

// ─── Internal helpers ─────────────────────────────────────────────────────────

const getGatewayUrl = () =>
  (process.env.ONDC_GATEWAY_URL || 'https://preprod.gateway.ondc.org').replace(/\/+$/, '');

// Build logistics context from retail context (we act as BAP/LBNP)
const buildLsContext = (action, retailContext, tenant, overrides = {}) => {
  const config = resolveOndcConfig(tenant);
  return {
    domain:         LOGISTICS_DOMAIN,
    country:        retailContext?.country || 'IND',
    city:           retailContext?.city    || '*',
    core_version:   LOGISTICS_VERSION,
    action,
    bap_id:         config.subscriber_id,
    bap_uri:        config.subscriber_url,
    timestamp:      new Date().toISOString(),
    ttl:            'PT30S',
    ...overrides,
  };
};

// POST request with ONDC signing header
const postWithAuth = async (url, payload, tenant) => {
  const config  = resolveOndcConfig(tenant);
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
    logger.warn('Logistics auth header failed:', e.message);
  }
  const resp = await axios.post(url, payload, { headers, timeout: 30000 });
  return resp.data;
};

// ─── Outbound API calls ───────────────────────────────────────────────────────

/**
 * 1. searchLogistics — send /search to ONDC gateway after retail /confirm
 *    Returns { txnId, msgId, lsContext } to store in logistics cache
 */
const searchLogistics = async (retailOrder, retailContext, tenant) => {
  const txnId = uuidv4();
  const msgId = uuidv4();

  const deliveryFl = (retailOrder.fulfillments || []).find(f => f.type === 'Delivery')
    || retailOrder.fulfillments?.[0] || {};

  const pickup  = deliveryFl.start || {};
  const dropoff = deliveryFl.end   || {};

  // Estimate weight (500g per unit as fallback)
  const totalUnits = (retailOrder.items || []).reduce((s, i) => s + (i.quantity?.count || 1), 0);
  const weightGrams = String(Math.max(totalUnits * 500, 500));

  const lsContext = buildLsContext('search', retailContext, tenant, {
    transaction_id: txnId,
    message_id:     msgId,
  });

  const payload = {
    context: lsContext,
    message: {
      intent: {
        fulfillment: {
          type: 'Delivery',
          '@ondc/org/linked_order': {
            id:          retailOrder.id,
            provider_id: retailOrder.provider?.id || '',
          },
          start: {
            location: {
              gps:     pickup.location?.gps || '12.914082,77.638980',
              address: { area_code: pickup.location?.address?.area_code || '560001' },
            },
            time: {
              range: {
                start: new Date().toISOString(),
                end:   new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
              },
            },
          },
          end: {
            location: {
              gps:     dropoff.location?.gps || '12.914082,77.638980',
              address: { area_code: dropoff.location?.address?.area_code || '560001' },
            },
            time: {
              range: {
                start: new Date().toISOString(),
                end:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              },
            },
          },
        },
        payment: { type: 'ON-FULFILLMENT' },
        tags: [
          {
            code: 'linked_order',
            list: [
              { code: 'id',          value: retailOrder.id           || '' },
              { code: 'provider_id', value: retailOrder.provider?.id || '' },
            ],
          },
        ],
        '@ondc/org/payload_details': {
          weight:     { unit: 'Gram', value: weightGrams },
          dimensions: {
            length:  { unit: 'centimeter', value: '10' },
            breadth: { unit: 'centimeter', value: '10' },
            height:  { unit: 'centimeter', value: '10' },
          },
          category:        'Express Delivery',
          dangerous_goods: false,
        },
      },
    },
  };

  const url = `${getGatewayUrl()}/search`;
  logger.info('Logistics /search → gateway', { txnId, url });
  try {
    await postWithAuth(url, payload, tenant);
  } catch (e) {
    logger.warn('Logistics /search gateway response:', e.response?.status, e.message);
    // Gateway returns ACK synchronously — 200 is fine
  }

  return { txnId, msgId, lsContext };
};

/**
 * 2. initLogistics — send /init to LSP (picked from on_search)
 */
const initLogistics = async ({ providerId, item, fulfillment }, lsContext, retailOrder, tenant) => {
  const msgId = uuidv4();
  const ctx   = { ...lsContext, action: 'init', message_id: msgId, timestamp: new Date().toISOString() };

  const deliveryFl = (retailOrder.fulfillments || []).find(f => f.type === 'Delivery')
    || retailOrder.fulfillments?.[0] || {};

  const payload = {
    context: ctx,
    message: {
      order: {
        provider:     { id: providerId },
        items:        [{ id: item.id, descriptor: item.descriptor, category_id: item.category_id }],
        fulfillments: [{
          ...fulfillment,
          id:   fulfillment.id   || 'f1',
          type: fulfillment.type || 'Delivery',
          start: deliveryFl.start || fulfillment.start || {},
          end:   deliveryFl.end   || fulfillment.end   || {},
        }],
        payment: { type: 'ON-FULFILLMENT' },
        billing: retailOrder.billing || {
          name:         'CottKart',
          address:      { city: 'Bengaluru', state: 'Karnataka', country: 'IND', area_code: '560001' },
          phone:        process.env.SUPPORT_PHONE || '+919999999999',
          email:        process.env.SUPPORT_EMAIL || 'support@cottkart.com',
          created_at:   new Date().toISOString(),
          updated_at:   new Date().toISOString(),
        },
      },
    },
  };

  const url = `${(lsContext.bpp_uri || '').replace(/\/+$/, '')}/init`;
  logger.info('Logistics /init → LSP', { txnId: lsContext.transaction_id, url });
  try {
    await postWithAuth(url, payload, tenant);
  } catch (e) {
    logger.warn('Logistics /init failed:', e.response?.status, e.message);
  }
  return { msgId };
};

/**
 * 3. confirmLogistics — send /confirm to LSP (order from on_init)
 */
const confirmLogistics = async (lsOrder, lsContext, tenant) => {
  const msgId = uuidv4();
  const ctx   = { ...lsContext, action: 'confirm', message_id: msgId, timestamp: new Date().toISOString() };

  const payload = {
    context: ctx,
    message: { order: lsOrder },
  };

  const url = `${(lsContext.bpp_uri || '').replace(/\/+$/, '')}/confirm`;
  logger.info('Logistics /confirm → LSP', { txnId: lsContext.transaction_id, url });
  try {
    await postWithAuth(url, payload, tenant);
  } catch (e) {
    logger.warn('Logistics /confirm failed:', e.response?.status, e.message);
  }
  return { msgId };
};

/**
 * 4. trackLogistics — send /track to LSP
 */
const trackLogistics = async (logisticsOrderId, lsContext, tenant) => {
  const msgId = uuidv4();
  const ctx   = { ...lsContext, action: 'track', message_id: msgId, timestamp: new Date().toISOString() };

  const payload = {
    context: ctx,
    message: { order_id: logisticsOrderId },
  };

  const url = `${(lsContext.bpp_uri || '').replace(/\/+$/, '')}/track`;
  logger.info('Logistics /track → LSP', { logisticsOrderId, url });
  try {
    await postWithAuth(url, payload, tenant);
  } catch (e) {
    logger.warn('Logistics /track failed:', e.response?.status, e.message);
  }
  return { msgId };
};

/**
 * 5. cancelLogistics — send /cancel to LSP (for merchant-side RTO, Flow A2)
 */
const cancelLogistics = async (logisticsOrderId, lsContext, tenant) => {
  const msgId = uuidv4();
  const ctx   = { ...lsContext, action: 'cancel', message_id: msgId, timestamp: new Date().toISOString() };

  const payload = {
    context: ctx,
    message: {
      order_id:               logisticsOrderId,
      cancellation_reason_id: '013',
    },
  };

  const url = `${(lsContext.bpp_uri || '').replace(/\/+$/, '')}/cancel`;
  logger.info('Logistics /cancel → LSP', { logisticsOrderId, url });
  try {
    await postWithAuth(url, payload, tenant);
  } catch (e) {
    logger.warn('Logistics /cancel failed:', e.response?.status, e.message);
  }
  return { msgId };
};

/**
 * 6. statusLogistics — send /status to LSP
 */
const statusLogistics = async (logisticsOrderId, lsContext, tenant) => {
  const msgId = uuidv4();
  const ctx   = { ...lsContext, action: 'status', message_id: msgId, timestamp: new Date().toISOString() };

  const payload = {
    context: ctx,
    message: { order_id: logisticsOrderId },
  };

  const url = `${(lsContext.bpp_uri || '').replace(/\/+$/, '')}/status`;
  logger.info('Logistics /status → LSP', { logisticsOrderId, url });
  try {
    await postWithAuth(url, payload, tenant);
  } catch (e) {
    logger.warn('Logistics /status failed:', e.response?.status, e.message);
  }
  return { msgId };
};

module.exports = {
  LOGISTICS_DOMAIN,
  searchLogistics,
  initLogistics,
  confirmLogistics,
  cancelLogistics,
  trackLogistics,
  statusLogistics,
};
