const cron = require('node-cron');
const { pool } = require('../config/database');
const { fetchOrderStatus } = require('../services/cloudkart/order.service');
const { sendCallback, getTenantByBppId } = require('../services/ondc/order.service');
const logger = require('../utils/logger');

// Map CottKart status codes to ONDC fulfillment states
const STATUS_MAP = {
  confirmed:       'Accepted',
  packed:          'In-progress',
  shipped:         'Order-picked-up',
  out_for_delivery: 'Out-for-delivery',
  delivered:       'Order-delivered',
  cancelled:       'Cancelled',
  returned:        'Return-delivered',
};

const runOrderSync = async () => {
  logger.info('[OrderSync] Started');

  try {
    const [orders] = await pool.query(`
      SELECT * FROM ondc_orders
      WHERE status IN ('confirmed', 'packed', 'shipped')
        AND cottkart_order_id IS NOT NULL
      LIMIT 100
    `);

    for (const order of orders) {
      try {
        const ckData = await fetchOrderStatus(order.cottkart_order_id);
        if (!ckData?.status) continue;

        const newStatus = ckData.status;
        if (newStatus === order.status) continue;

        // Update local DB
        await pool.query(
          `UPDATE ondc_orders SET status = ?, updated_at = NOW() WHERE id = ?`,
          [newStatus, order.id]
        );

        // Send on_status callback to BAP
        if (order.bap_uri) {
          const tenant = await getTenantByBppId(null).catch(() => null);
          if (tenant && order.tenant_id === tenant.id) {
            const context = {
              bap_id:       order.bap_id,
              bap_uri:      order.bap_uri,
              transaction_id: order.ondc_transaction_id,
              domain:       'ONDC:RET10',
              action:       'status',
              city:         'std:044',
              country:      'IND',
              core_version: '1.2.0',
              timestamp:    new Date().toISOString(),
            };

            await sendCallback(order.bap_uri, 'on_status', context, {
              order: {
                id:    order.ondc_order_id,
                state: STATUS_MAP[newStatus] || newStatus,
                fulfillments: [{
                  id:   'f1',
                  type: 'Delivery',
                  state: { descriptor: { code: STATUS_MAP[newStatus] || newStatus } },
                  tracking: Boolean(ckData.tracking_url),
                }],
                updated_at: new Date().toISOString(),
              },
            }, tenant);

            logger.info(`[OrderSync] ${order.ondc_order_id}: ${order.status} → ${newStatus}`);
          }
        }
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
