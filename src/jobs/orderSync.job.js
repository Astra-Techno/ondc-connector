const cron = require('node-cron');
const { pool } = require('../config/database');
const { fetchOrderStatus } = require('../services/cloudkart/order.service');
const { sendCallback } = require('../services/ondc/order.service');
const logger = require('../utils/logger');

// Maps CottKart status → { fulfillmentState, orderState } per ONDC spec
const STATUS_MAP = {
  confirmed:        { fulfillmentState: 'Pending',           orderState: 'Accepted' },
  packed:           { fulfillmentState: 'Packed',            orderState: 'In-progress' },
  shipped:          { fulfillmentState: 'Order-picked-up',   orderState: 'In-progress' },
  out_for_delivery: { fulfillmentState: 'Out-for-delivery',  orderState: 'In-progress' },
  delivered:        { fulfillmentState: 'Order-delivered',   orderState: 'Completed' },
  cancelled:        { fulfillmentState: 'Cancelled',         orderState: 'Cancelled' },
  returned:         { fulfillmentState: 'Return-Delivered',  orderState: 'Completed' },
};

// Terminal statuses — stop polling once reached
const TERMINAL_STATUSES = new Set(['delivered', 'cancelled', 'returned']);

const runOrderSync = async () => {
  logger.info('[OrderSync] Started');

  try {
    // Fetch all active orders that still need status tracking
    const [orders] = await pool.query(`
      SELECT o.*,
             oc.subscriber_id AS bpp_id,
             oc.subscriber_url AS bpp_uri,
             oc.signing_private_key, oc.unique_key_id, oc.ondc_env,
             oc.id AS ondc_config_id
      FROM ondc_orders o
      JOIN tenant_ondc_config oc ON oc.tenant_id = o.tenant_id AND oc.is_active = 1
      WHERE o.status NOT IN ('delivered', 'cancelled', 'returned')
        AND o.cottkart_order_id IS NOT NULL
      LIMIT 100
    `);

    for (const order of orders) {
      try {
        // Fetch latest status from CottKart
        const ckData = await fetchOrderStatus(order.cottkart_order_id);
        if (!ckData?.status) continue;

        const newStatus = ckData.status.toLowerCase().replace(/ /g, '_');
        if (newStatus === order.status) continue;

        // Only process known statuses
        const mapped = STATUS_MAP[newStatus];
        if (!mapped) continue;

        // Update DB
        await pool.query(
          `UPDATE ondc_orders SET status = ?, updated_at = NOW() WHERE id = ?`,
          [newStatus, order.id]
        );

        if (!order.bap_uri) continue;

        // Build context from stored order data
        const rawPayload = (() => {
          try { return order.raw_payload ? JSON.parse(order.raw_payload) : null; } catch { return null; }
        })();
        const storedContext = rawPayload?.context || {};

        const context = {
          domain:         storedContext.domain       || 'ONDC:RET10',
          country:        storedContext.country      || 'IND',
          city:           storedContext.city         || 'std:044',
          core_version:   storedContext.core_version || '1.2.0',
          bap_id:         order.bap_id,
          bap_uri:        order.bap_uri,
          bpp_id:         order.bpp_id,
          bpp_uri:        order.bpp_uri,
          transaction_id: order.ondc_transaction_id,
          timestamp:      new Date().toISOString(),
        };

        // Parse stored order fields for full on_status payload
        const storedItems       = (() => { try { return order.items       ? JSON.parse(order.items)       : null; } catch { return null; } })();
        const storedFulfillment = (() => { try { return order.fulfillment ? JSON.parse(order.fulfillment) : null; } catch { return null; } })();
        const storedPayment     = (() => { try { return order.payment     ? JSON.parse(order.payment)     : null; } catch { return null; } })();
        const storedQuote       = (() => { try { return order.quote       ? JSON.parse(order.quote)       : null; } catch { return null; } })();
        const storedOrder       = rawPayload?.message?.order || {};

        const now = new Date().toISOString();

        // Build fulfillments array — preserve original fulfillment data, update state
        const fulfillments = storedFulfillment
          ? [{ ...storedFulfillment, state: { descriptor: { code: mapped.fulfillmentState } }, tracking: Boolean(ckData.tracking_url) }]
          : [{ id: 'f1', type: 'Delivery', state: { descriptor: { code: mapped.fulfillmentState } }, tracking: Boolean(ckData.tracking_url) }];

        // Build tracking tag if URL available
        if (ckData.tracking_url) {
          fulfillments[0].tracking = true;
          fulfillments[0].tags = [{ code: 'tracking', list: [{ code: 'url', value: ckData.tracking_url }] }];
        }

        const tenant = {
          id:                  order.tenant_id,
          tenant_id:           order.tenant_id,
          ondc_config_id:      order.ondc_config_id,
          subscriber_id:       order.bpp_id,
          subscriber_url:      order.bpp_uri,
          signing_private_key: order.signing_private_key,
          unique_key_id:       order.unique_key_id,
        };

        await sendCallback(order.bap_uri, 'on_status', context, {
          order: {
            id:           order.ondc_order_id,
            state:        mapped.orderState,
            provider:     storedOrder.provider     || null,
            items:        storedItems               || storedOrder.items || [],
            billing:      storedOrder.billing       || null,
            fulfillments,
            quote:        storedQuote               || storedOrder.quote || null,
            payment:      storedPayment             || storedOrder.payment || null,
            created_at:   storedOrder.created_at    || now,
            updated_at:   now,
          },
        }, tenant);

        logger.info(`[OrderSync] on_status sent: ${order.ondc_order_id} → ${mapped.fulfillmentState} (${mapped.orderState})`);
      } catch (orderErr) {
        logger.warn(`[OrderSync] Order ${order.ondc_order_id} failed:`, orderErr.message);
      }
    }
  } catch (err) {
    logger.error('[OrderSync] Fatal error:', err.message || String(err));
    if (err.code) logger.error('[OrderSync] Error code:', err.code);
    if (err.sql) logger.error('[OrderSync] SQL:', err.sql);
  }

  logger.info('[OrderSync] Done');
};

const startOrderSync = () => {
  cron.schedule('*/5 * * * *', runOrderSync);
  logger.info('[OrderSync] Scheduler started (every 5 min)');
};

module.exports = { startOrderSync, runOrderSync };
