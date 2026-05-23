const cron = require('node-cron');
const { pool } = require('../config/database');
const { fetchInventory } = require('../services/cloudkart/catalog.service');
const logger = require('../utils/logger');

const runInventorySync = async () => {
  logger.info('[InventorySync] Started');
  let totalUpdated = 0;

  try {
    const [vendors] = await pool.query(`
      SELECT v.*, t.id as tenant_id
      FROM vendors v
      JOIN tenants t ON t.id = v.tenant_id
      WHERE v.status = 'active' AND t.status = 'active'
    `);

    for (const vendor of vendors) {
      try {
        const inventory = await fetchInventory(vendor.external_vendor_id);

        for (const item of inventory) {
          const productId = String(item.product_id || item.id);
          const stock     = parseInt(item.stock || item.quantity || 0);

          await pool.query(
            `UPDATE products SET stock = ?, updated_at = NOW()
             WHERE external_product_id = ? AND tenant_id = ?`,
            [stock, productId, vendor.tenant_id]
          );
          totalUpdated++;
        }

        logger.info(`[InventorySync] Vendor ${vendor.external_vendor_id}: ${inventory.length} items updated`);
      } catch (err) {
        logger.error(`[InventorySync] Vendor ${vendor.external_vendor_id} failed:`, err.message);
      }
    }
  } catch (err) {
    logger.error('[InventorySync] Fatal error:', err.message);
  }

  logger.info(`[InventorySync] Done — ${totalUpdated} products updated`);
};

const startInventorySync = () => {
  cron.schedule('*/15 * * * *', runInventorySync);
  logger.info('[InventorySync] Scheduler started (every 15 min)');
};

module.exports = { startInventorySync, runInventorySync };
