// On-Network Logistics — inbound callback handlers (from LSP/Pramaan mock)
// These arrive at our existing routes (on_search, on_init, on_confirm, on_status, on_track)
// Differentiated from retail by context.domain === 'nic2004:60232'

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { sendCallback } = require('../services/ondc/order.service');
const {
  LOGISTICS_DOMAIN,
  initLogistics,
  confirmLogistics,
  cancelLogistics,
  trackLogistics,
  statusLogistics,
} = require('../services/logistics/lsp.service');

// ─── In-memory state ──────────────────────────────────────────────────────────
// retail_order_id → { lsTransactionId, lsContext, retailContext, retailOrder,
//                     tenant, retailDeliveryFl, lspProvider, lsOrder,
//                     logisticsOrderId, logisticsConfirmed,
//                     logisticsDelivered, retailCancelled }
const logisticsOrderCache = new Map();

// Lookup by logistics transaction_id (used in callbacks which carry ls txn_id)
const getByLsTxn = (txnId) => {
  for (const [orderId, entry] of logisticsOrderCache) {
    if (entry.lsTransactionId === txnId) return { orderId, entry };
  }
  return null;
};

// Called by handleConfirm after successful retail on_confirm + logistics /search
const startLogisticsFlow = async (retailOrder, retailContext, tenant, lsSearchResult, vendor = null) => {
  const { txnId, lsContext } = lsSearchResult;
  const deliveryFl = (retailOrder.fulfillments || []).find(f => f.type === 'Delivery')
    || retailOrder.fulfillments?.[0] || null;

  logisticsOrderCache.set(retailOrder.id, {
    lsTransactionId:  txnId,
    lsContext,
    retailContext,
    retailOrder,
    tenant,
    vendor,
    retailDeliveryFl: deliveryFl,
    lspProvider:        null,
    lsOrder:            null,
    logisticsOrderId:   null,
    logisticsConfirmed: false,
    logisticsDelivered: false,
    retailCancelled:    false,
  });

  logger.info('Logistics flow started', {
    retailOrderId: retailOrder.id,
    lsTxnId: txnId,
  });
};

// ─── Inbound callback handlers ────────────────────────────────────────────────

/**
 * on_search from LSP — pick first provider/item, send /init
 */
const handleLogisticsOnSearch = async (body) => {
  const { context, message } = body;
  const txnId = context?.transaction_id;
  logger.info('Logistics on_search received', { txnId, bpp_id: context?.bpp_id });

  const found = getByLsTxn(txnId);
  if (!found) {
    logger.warn('Logistics on_search: no cached retail order for ls txn', { txnId });
    return;
  }
  const { orderId, entry } = found;

  // catalog format: bpp/providers or providers
  const catalog    = message?.catalog;
  const providers  = catalog?.['bpp/providers'] || catalog?.providers || [];
  if (!providers.length) {
    logger.warn('Logistics on_search: empty catalog — no providers', { txnId });
    return;
  }

  const provider  = providers[0];
  const items     = provider?.items || [];
  const item      = items[0];
  if (!item) {
    logger.warn('Logistics on_search: provider has no items', { txnId, providerId: provider.id });
    return;
  }

  const fulfillments = provider?.fulfillments || [];
  const fulfillment  = fulfillments.find(f => f.type === 'Delivery') || fulfillments[0] || {};

  // Update lsContext with LSP's bpp_id/bpp_uri so subsequent calls go to correct LSP
  const lsContext = {
    ...entry.lsContext,
    bpp_id:  context.bpp_id,
    bpp_uri: context.bpp_uri,
  };
  entry.lsContext    = lsContext;
  entry.lspProvider  = { id: provider.id, item, fulfillment };

  logger.info('Logistics on_search: selected provider', {
    orderId, providerId: provider.id, itemId: item.id,
  });

  await initLogistics(
    { providerId: provider.id, item, fulfillment },
    lsContext,
    entry.retailOrder,
    entry.tenant
  );
};

/**
 * on_init from LSP — save order, send /confirm
 */
const handleLogisticsOnInit = async (body) => {
  const { context, message } = body;
  const txnId = context?.transaction_id;
  logger.info('Logistics on_init received', { txnId });

  const found = getByLsTxn(txnId);
  if (!found) {
    logger.warn('Logistics on_init: no cached entry for ls txn', { txnId });
    return;
  }
  const { orderId, entry } = found;

  const lsOrder = message?.order;
  if (!lsOrder) {
    logger.warn('Logistics on_init: no order in message', { txnId });
    return;
  }

  entry.lsOrder = lsOrder;
  logger.info('Logistics on_init: sending /confirm', { orderId, lsOrderId: lsOrder.id });
  await confirmLogistics(lsOrder, entry.lsContext, entry.tenant);
};

/**
 * on_confirm from LSP — store logistics order id, logistics flow complete
 */
const handleLogisticsOnConfirm = async (body) => {
  const { context, message } = body;
  const txnId = context?.transaction_id;
  logger.info('Logistics on_confirm received', { txnId });

  const found = getByLsTxn(txnId);
  if (!found) {
    logger.warn('Logistics on_confirm: no cached entry for ls txn', { txnId });
    return;
  }
  const { orderId, entry } = found;

  const lsOrder = message?.order;
  entry.logisticsOrderId  = lsOrder?.id || entry.lsOrder?.id;
  entry.logisticsConfirmed = true;

  logger.info('Logistics order confirmed by LSP', {
    retailOrderId:    orderId,
    logisticsOrderId: entry.logisticsOrderId,
    lsTxnId:          txnId,
  });
};

// Map logistics fulfillment state → retail fulfillment state
const LS_TO_RETAIL_STATE = {
  'Pending':            'Packed',
  'Agent-assigned':     'Agent-assigned',
  'Order-picked-up':    'Order-picked-up',
  'Out-for-delivery':   'Out-for-delivery',
  'Order-delivered':    'Order-delivered',
  'RTO-Initiated':      'RTO-Initiated',
  'RTO-Delivered':      'RTO-Delivered',
  'Cancelled':          'Cancelled',
};

const TERMINAL_STATES = new Set(['Order-delivered', 'Cancelled', 'RTO-Delivered']);

// Build a logistics-relayed fulfillment with all required ONDC fields
const buildLogisticsRelayFulfillment = (f, vendor, retailState, now) => {
  const t1h  = new Date(new Date(now).getTime() +  1 * 3600 * 1000).toISOString();
  const t2h  = new Date(new Date(now).getTime() +  2 * 3600 * 1000).toISOString();
  const t24h = new Date(new Date(now).getTime() + 24 * 3600 * 1000).toISOString();
  const t48h = new Date(new Date(now).getTime() + 48 * 3600 * 1000).toISOString();
  const phone = (vendor?.phone || '9999999999').replace(/^\+91/, '');
  const gps   = vendor?.gps || '12.914082,77.638980';

  return {
    ...f,
    id:       f.id   || 'f1',
    type:     f.type || 'Delivery',
    state:    { descriptor: { code: retailState } },
    tracking: false,
    '@ondc/org/provider_name': vendor?.business_name || vendor?.name || 'Store',
    '@ondc/org/category':      f['@ondc/org/category'] || 'Grocery',
    '@ondc/org/TAT':           f['@ondc/org/TAT']      || 'PT24H',
    start: f.start || {
      location: {
        id:  'l1',
        gps,
        descriptor: { name: vendor?.business_name || vendor?.name || 'Store' },
        address: {
          locality:  vendor?.address || vendor?.city || 'Location',
          city:      vendor?.city    || 'Bengaluru',
          area_code: vendor?.pincode || '560001',
          state:     vendor?.state   || 'Karnataka',
        },
      },
      time:    { range: { start: t1h, end: t2h }, timestamp: t1h },
      instructions: {
        code: '1',
        name: 'Ready for pickup',
        short_desc: 'Order is ready for pickup',
        long_desc: 'Order has been packed and is ready for pickup by logistics',
        images: ['https://ondc.cottkart.com/pickup-instructions.png'],
      },
      contact: { phone, email: vendor?.email || process.env.SUPPORT_EMAIL || 'support@store.in' },
    },
    end: {
      ...(f.end || {}),
      time: f.end?.time || { range: { start: t24h, end: t48h }, timestamp: t48h },
    },
  };
};

/**
 * on_status from LSP — relay as retail on_status to BAP
 */
const handleLogisticsOnStatus = async (body) => {
  const { context, message } = body;
  const txnId = context?.transaction_id;
  logger.info('Logistics on_status received', { txnId });

  const found = getByLsTxn(txnId);
  if (!found) {
    logger.warn('Logistics on_status: no cached entry for ls txn', { txnId });
    return;
  }
  const { orderId, entry } = found;

  const lsOrder       = message?.order;
  const lsFulfillment = lsOrder?.fulfillments?.[0];
  const lsState       = lsFulfillment?.state?.descriptor?.code || 'Order-delivered';

  const retailState = LS_TO_RETAIL_STATE[lsState] || lsState;
  const orderState  = TERMINAL_STATES.has(retailState) ? 'Completed' : 'In-progress';

  // Track that LSP has delivered (used to skip auto-status Order-delivered for logistics orders)
  if (retailState === 'Order-delivered') {
    entry.logisticsDelivered = true;
    logger.info('Logistics Order-delivered received — relaying to BAP (Pramaan Flow A2 requires it before cancel)', { orderId });
  }

  // If merchant already cancelled, skip non-RTO states (RTO-Initiated/RTO-Delivered still relay)
  if (entry.retailCancelled && !retailState.startsWith('RTO-')) {
    logger.info('Logistics on_status skipped — retail order cancelled', { orderId, retailState });
    return;
  }

  const now = new Date().toISOString();
  const retailOrder = entry.retailOrder;
  const vendor = entry.vendor;

  // Build retail on_status payload — map logistics fulfillment state to retail
  const statusPayload = {
    id:    orderId,
    state: orderState,
    provider:  retailOrder.provider,
    items:     retailOrder.items,
    billing:   retailOrder.billing,
    fulfillments: (retailOrder.fulfillments || [{ id: 'f1', type: 'Delivery' }])
      .filter(f => f.type !== 'Cancel')
      .map(f => buildLogisticsRelayFulfillment(f, vendor, retailState, now)),
    quote:      retailOrder.quote,
    payment:    retailOrder.payment,
    tags:       retailOrder.tags || [],
    created_at: retailOrder.created_at || now,
    updated_at: retailOrder.updated_at || now,
  };

  const retailCtx = { ...entry.retailContext, message_id: uuidv4() };
  await sendCallback(retailCtx.bap_uri, 'on_status', retailCtx, { order: statusPayload }, entry.tenant);
  logger.info('Retail on_status relayed from logistics', { orderId, retailState, orderState });
};

/**
 * on_track from LSP — log, relay tracking URL to retail if present
 */
const handleLogisticsOnTrack = async (body) => {
  const { context, message } = body;
  const txnId = context?.transaction_id;
  logger.info('Logistics on_track received', { txnId, url: message?.tracking?.url });
  // Tracking URL can be surfaced to retail BAP via on_track if needed
};

/**
 * Mark retail order as cancelled so logistics relay suppresses further status updates.
 * Called from triggerMerchantCancel in ondc.controller.
 */
const markRetailOrderCancelled = (retailOrderId) => {
  const entry = logisticsOrderCache.get(retailOrderId);
  if (entry) {
    entry.retailCancelled = true;
    logger.info('Logistics relay: retail order marked cancelled', { retailOrderId });
  }
};

/**
 * Send /cancel to LSP for an active logistics order (Flow A2 RTO).
 * Called from triggerMerchantCancel.
 */
const cancelLogisticsOrder = async (retailOrderId) => {
  const entry = logisticsOrderCache.get(retailOrderId);
  if (!entry?.logisticsConfirmed) return;
  await cancelLogistics(entry.logisticsOrderId, entry.lsContext, entry.tenant);
};

/**
 * Called when retail /track is received — relay /track to logistics LSP
 */
const relayTrackToLogistics = async (retailOrderId, retailContext) => {
  const entry = logisticsOrderCache.get(retailOrderId);
  if (!entry?.logisticsConfirmed) return;
  await trackLogistics(entry.logisticsOrderId, entry.lsContext, entry.tenant);
};

/**
 * Called when retail /status is received — relay /status to logistics LSP
 */
const relayStatusToLogistics = async (retailOrderId) => {
  const entry = logisticsOrderCache.get(retailOrderId);
  if (!entry?.logisticsConfirmed) return;
  await statusLogistics(entry.logisticsOrderId, entry.lsContext, entry.tenant);
};

module.exports = {
  LOGISTICS_DOMAIN,
  logisticsOrderCache,
  startLogisticsFlow,
  handleLogisticsOnSearch,
  handleLogisticsOnInit,
  handleLogisticsOnConfirm,
  handleLogisticsOnStatus,
  handleLogisticsOnTrack,
  relayTrackToLogistics,
  relayStatusToLogistics,
  markRetailOrderCancelled,
  cancelLogisticsOrder,
};
