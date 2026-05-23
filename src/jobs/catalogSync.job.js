const cron = require('node-cron');
const { pool } = require('../config/database');
const { fetchProducts } = require('../services/cloudkart/catalog.service');
const logger = require('../utils/logger');

const upsertProduct = async (tenantId, vendorDbId, p) => {
  await pool.query(`
    INSERT INTO products
      (tenant_id, vendor_id, external_product_id, name, description,
       price, mrp, stock, category, hsn_code, unit,
       images, image_url, is_returnable, is_cancellable,
       time_to_ship, available_on_cod, is_active,
       ondc_sync_status, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', NOW())
    ON DUPLICATE KEY UPDATE
      name             = VALUES(name),
      description      = VALUES(description),
      price            = VALUES(price),
      mrp              = VALUES(mrp),
      stock            = VALUES(stock),
      images           = VALUES(images),
      image_url        = VALUES(image_url),
      is_active        = VALUES(is_active),
      ondc_sync_status = 'synced',
      last_synced_at   = NOW(),
      updated_at       = NOW()
  `, [
    tenantId, vendorDbId, p.product_id,
    p.name, p.description,
    p.price, p.mrp, p.stock,
    p.category, p.hsn_code, p.unit,
    JSON.stringify(p.images),
    p.images?.[0] || null,
    p.is_returnable   ? 1 : 0,
    p.is_cancellable  ? 1 : 0,
    p.time_to_ship,
    p.available_on_cod ? 1 : 0,
    p.is_active        ? 1 : 0,
  ]);
};

const runCatalogSync = async () => {
  logger.info('[CatalogSync] Started');
  const startedAt = new Date();
  let totalSynced = 0;
  let totalFailed = 0;

  try {
    const [vendors] = await pool.query(`
      SELECT v.*, t.id as tenant_id
      FROM vendors v
      JOIN tenants t ON t.id = v.tenant_id
      WHERE v.status = 'active' AND t.status = 'active'
    `);

    for (const vendor of vendors) {
      try {
        const products = await fetchProducts(vendor.external_vendor_id, 1, 200);
        let synced = 0;
        let failed = 0;

        for (const product of products) {
          try {
            await upsertProduct(vendor.tenant_id, vendor.id, product);
            synced++;
          } catch (e) {
            failed++;
            logger.warn(`[CatalogSync] Product ${product.product_id} failed:`, e.message);
            await pool.query(
              `UPDATE products SET ondc_sync_status = 'failed' WHERE external_product_id = ? AND tenant_id = ?`,
              [product.product_id, vendor.tenant_id]
            ).catch(() => {});
          }
        }

        totalSynced += synced;
        totalFailed += failed;
        logger.info(`[CatalogSync] Vendor ${vendor.external_vendor_id}: ${synced} synced, ${failed} failed`);
      } catch (vendorErr) {
        logger.error(`[CatalogSync] Vendor ${vendor.external_vendor_id} failed:`, vendorErr.message);
        await pool.query(
          `UPDATE products SET ondc_sync_status = 'failed', updated_at = NOW()
           WHERE vendor_id = ? AND tenant_id = ?`,
          [vendor.id, vendor.tenant_id]
        ).catch(() => {});
      }
    }
  } catch (err) {
    logger.error('[CatalogSync] Fatal error:', err.message);
  }

  // Write sync log
  try {
    const [[firstVendor]] = await pool.query(
      `SELECT tenant_id FROM vendors WHERE status = 'active' LIMIT 1`
    );
    if (firstVendor) {
      await pool.query(`
        INSERT INTO sync_logs
          (tenant_id, sync_type, status, records_synced, records_failed, started_at, completed_at)
        VALUES (?, 'catalog', ?, ?, ?, ?, NOW())
      `, [
        firstVendor.tenant_id,
        totalFailed > 0 && totalSynced === 0 ? 'failed' : 'success',
        totalSynced,
        totalFailed,
        startedAt,
      ]);
    }
  } catch (e) {}

  logger.info(`[CatalogSync] Done — ${totalSynced} synced, ${totalFailed} failed`);
};

const startCatalogSync = () => {
  cron.schedule('*/30 * * * *', runCatalogSync);
  logger.info('[CatalogSync] Scheduler started (every 30 min)');
};

module.exports = { startCatalogSync, runCatalogSync };
