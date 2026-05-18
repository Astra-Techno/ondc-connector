const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const logger = require('../utils/logger');

// Sync products
const syncCatalog = async (req, res) => {
  const tenant = req.tenant;
  const { products } = req.body;

  if (!products || !Array.isArray(products) || products.length === 0) {
    return error(res, 'products array is required', 400);
  }

  let synced = 0, failed = 0;
  const errors = [];

  // Log sync start
  const [syncLog] = await pool.query(`
    INSERT INTO sync_logs (tenant_id, sync_type, status, total_items)
    VALUES (?, 'catalog', 'pending', ?)
  `, [tenant.id, products.length]);

  for (const p of products) {
    try {
      if (!p.product_id || !p.name || !p.price) {
        errors.push({ product_id: p.product_id, error: 'product_id, name and price required' });
        failed++;
        continue;
      }

      // Get vendor internal ID
      const [vendor] = await pool.query(
        'SELECT id FROM vendors WHERE tenant_id = ? AND external_vendor_id = ?',
        [tenant.id, p.vendor_id || 'owner']
      );

      const vendorId = vendor.length ? vendor[0].id : null;

      await pool.query(`
        INSERT INTO products
          (tenant_id, vendor_id, external_product_id, name, description, short_description,
           sku, hsn_code, price, mrp, currency, stock, unit, category_id,
           image_url, images, weight, weight_unit, is_returnable, is_cancellable,
           return_window, time_to_ship, available_on_cod, is_active, ondc_sync_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          description = VALUES(description),
          price = VALUES(price),
          mrp = VALUES(mrp),
          stock = VALUES(stock),
          images = VALUES(images),
          is_active = VALUES(is_active),
          ondc_sync_status = 'pending',
          updated_at = NOW()
      `, [
        tenant.id, vendorId, p.product_id,
        p.name, p.description || null, p.short_description || null,
        p.sku || null, p.hsn_code || null,
        p.price, p.mrp || p.price,
        p.currency || 'INR', p.stock || 0,
        p.unit || 'unit',
        p.images && p.images[0] ? p.images[0] : null,
        p.images ? JSON.stringify(p.images) : null,
        p.weight || null, p.weight_unit || 'kg',
        p.is_returnable ? 1 : 0,
        p.is_cancellable !== false ? 1 : 0,
        p.return_window || 'P1D',
        p.time_to_ship || 'PT24H',
        p.available_on_cod !== false ? 1 : 0,
        p.is_active !== false ? 1 : 0
      ]);

      synced++;
    } catch (err) {
      console.error(`Product sync failed for ${p.product_id}:`, err.message);
      errors.push({ product_id: p.product_id, error: err.message });
      failed++;
    }
  }

  // Update sync log
  await pool.query(`
    UPDATE sync_logs SET 
      status = ?, synced_items = ?, failed_items = ?, completed_at = NOW()
    WHERE id = ?
  `, [failed === 0 ? 'success' : 'partial', synced, failed, syncLog.insertId]);

  logger.info(`Catalog sync: ${synced} synced, ${failed} failed for tenant ${tenant.slug}`);

  return success(res, {
    total: products.length,
    synced, failed,
    ondc_pushed: synced,
    errors
  });
};

// Sync inventory only
const syncInventory = async (req, res) => {
  const tenant = req.tenant;
  const { inventory } = req.body;

  if (!inventory || !Array.isArray(inventory)) {
    return error(res, 'inventory array is required', 400);
  }

  let updated = 0, failed = 0;

  for (const item of inventory) {
    try {
      const [result] = await pool.query(`
        UPDATE products SET stock = ?, updated_at = NOW()
        WHERE tenant_id = ? AND external_product_id = ?
      `, [item.stock, tenant.id, item.product_id]);

      if (result.affectedRows > 0) updated++;
      else failed++;
    } catch (err) {
      failed++;
    }
  }

  return success(res, { total: inventory.length, updated, failed });
};

// Get products
const getProducts = async (req, res) => {
  try {
    const tenant = req.tenant;
    const { vendor_id, ondc_sync_status, is_active, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT p.*, v.business_name as vendor_name 
      FROM products p 
      LEFT JOIN vendors v ON v.id = p.vendor_id
      WHERE p.tenant_id = ?
    `;
    const params = [tenant.id];

    if (vendor_id) {
      query += ' AND v.external_vendor_id = ?';
      params.push(vendor_id);
    }
    if (ondc_sync_status) { query += ' AND p.ondc_sync_status = ?'; params.push(ondc_sync_status); }
    if (is_active !== undefined) { query += ' AND p.is_active = ?'; params.push(is_active === 'true' ? 1 : 0); }

    query += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [products] = await pool.query(query, params);
    const [[{ count }]] = await pool.query('SELECT COUNT(*) as count FROM products WHERE tenant_id = ?', [tenant.id]);

    return success(res, { products, total: count, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('FULL ERROR:', err); return error(res, err.message);
  }
};

// Get single product
const getProduct = async (req, res) => {
  try {
    const tenant = req.tenant;
    const [rows] = await pool.query(
      'SELECT * FROM products WHERE tenant_id = ? AND external_product_id = ?',
      [tenant.id, req.params.product_id]
    );
    if (!rows.length) return error(res, 'Product not found', 404);
    return success(res, rows[0]);
  } catch (err) {
    console.error('FULL ERROR:', err); return error(res, err.message);
  }
};

// Delete product
const deleteProduct = async (req, res) => {
  try {
    const tenant = req.tenant;
    await pool.query(
      'UPDATE products SET is_active = 0, updated_at = NOW() WHERE tenant_id = ? AND external_product_id = ?',
      [tenant.id, req.params.product_id]
    );
    return success(res, null, 'Product deactivated');
  } catch (err) {
    console.error('FULL ERROR:', err); return error(res, err.message);
  }
};

module.exports = { syncCatalog, syncInventory, getProducts, getProduct, deleteProduct };
