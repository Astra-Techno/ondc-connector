const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const logger = require('../utils/logger');

// Sync vendors from client platform
const syncVendors = async (req, res) => {
  const tenant = req.tenant;
  const { vendors } = req.body;

  if (!vendors || !Array.isArray(vendors) || vendors.length === 0) {
    return error(res, 'vendors array is required', 400);
  }

  let synced = 0, failed = 0;
  const errors = [];

  for (const v of vendors) {
    try {
      if (!v.vendor_id || !v.business_name) {
        errors.push({ vendor_id: v.vendor_id, error: 'vendor_id and business_name required' });
        failed++;
        continue;
      }

      await pool.query(`
        INSERT INTO vendors 
          (tenant_id, external_vendor_id, business_name, gstin, pan, phone, email, 
           address, city, state, pincode, country, gps, logo_url, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IND', ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          business_name = VALUES(business_name),
          gstin = VALUES(gstin),
          phone = VALUES(phone),
          email = VALUES(email),
          address = VALUES(address),
          city = VALUES(city),
          state = VALUES(state),
          pincode = VALUES(pincode),
          gps = VALUES(gps),
          logo_url = VALUES(logo_url),
          status = VALUES(status),
          updated_at = NOW()
      `, [
        tenant.id, v.vendor_id, v.business_name,
        v.gstin || null, v.pan || null,
        v.phone || null, v.email || null,
        v.address || null, v.city || null,
        v.state || null, v.pincode || null,
        v.gps || null, v.logo_url || null,
        v.ondc_eligible ? 'active' : 'pending'
      ]);

      synced++;
    } catch (err) {
      logger.error(`Vendor sync failed for ${v.vendor_id}:`, err.message);
      errors.push({ vendor_id: v.vendor_id, error: err.message });
      failed++;
    }
  }

  logger.info(`Vendor sync: ${synced} synced, ${failed} failed for tenant ${tenant.slug}`);

  return success(res, { total: vendors.length, synced, failed, errors });
};

// Get all vendors
const getVendors = async (req, res) => {
  try {
    const tenant = req.tenant;
    const { status, ondc_eligible, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT * FROM vendors WHERE tenant_id = ?';
    const params = [tenant.id];

    if (status) { query += ' AND status = ?'; params.push(status); }
    if (ondc_eligible === 'true') { query += ' AND status = "active"'; }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [vendors] = await pool.query(query, params);
    const [[{ count }]] = await pool.query('SELECT COUNT(*) as count FROM vendors WHERE tenant_id = ?', [tenant.id]);

    return success(res, { vendors, total: count, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    logger.error('Get vendors failed:', err.message);
    return error(res, err.message);
  }
};

// Get single vendor
const getVendor = async (req, res) => {
  try {
    const tenant = req.tenant;
    const [rows] = await pool.query(
      'SELECT * FROM vendors WHERE tenant_id = ? AND external_vendor_id = ?',
      [tenant.id, req.params.vendor_id]
    );
    if (!rows.length) return error(res, 'Vendor not found', 404);
    return success(res, rows[0]);
  } catch (err) {
    return error(res, err.message);
  }
};

// Update vendor
const updateVendor = async (req, res) => {
  try {
    const tenant = req.tenant;
    const updates = req.body;
    const [vendor] = await pool.query(
      'SELECT * FROM vendors WHERE tenant_id = ? AND external_vendor_id = ?',
      [tenant.id, req.params.vendor_id]
    );
    if (!vendor.length) return error(res, 'Vendor not found', 404);

    await pool.query(`
      UPDATE vendors SET
        business_name = COALESCE(?, business_name),
        gstin = COALESCE(?, gstin),
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        address = COALESCE(?, address),
        city = COALESCE(?, city),
        state = COALESCE(?, state),
        pincode = COALESCE(?, pincode),
        gps = COALESCE(?, gps),
        updated_at = NOW()
      WHERE tenant_id = ? AND external_vendor_id = ?
    `, [
      updates.business_name, updates.gstin, updates.phone,
      updates.email, updates.address, updates.city,
      updates.state, updates.pincode, updates.gps,
      tenant.id, req.params.vendor_id
    ]);

    return success(res, null, 'Vendor updated');
  } catch (err) {
    return error(res, err.message);
  }
};

module.exports = { syncVendors, getVendors, getVendor, updateVendor };
