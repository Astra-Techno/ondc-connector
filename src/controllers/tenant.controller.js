const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const crypto = require('crypto');
const logger = require('../utils/logger');

// Generate API key
const generateApiKey = () => {
  return 'ck_live_' + crypto.randomBytes(24).toString('hex');
};

// Register new tenant
const registerTenant = async (req, res) => {
  try {
    const { name, slug, domain, api_url, type, contact_name, contact_email, contact_phone, platform } = req.body;

    if (!name || !slug) {
      return error(res, 'Name and slug are required', 400);
    }

    // Check slug exists
    const [existing] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
    if (existing.length > 0) {
      return error(res, 'Slug already exists', 409);
    }

    const apiKey = generateApiKey();

    // Create tenant
    const [result] = await pool.query(`
      INSERT INTO tenants (name, slug, domain, api_url, api_type, type, status, plan)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 'basic')
    `, [name, slug, domain, api_url, platform || 'custom', type || 'single_store']);

    const tenantId = result.insertId;

    // Create API key
    await pool.query(`
      INSERT INTO api_keys (tenant_id, name, key_value)
      VALUES (?, 'Default Key', ?)
    `, [tenantId, apiKey]);

    // Auto create vendor for single store
    if (type === 'single_store') {
      await pool.query(`
        INSERT INTO vendors (tenant_id, external_vendor_id, business_name, email, phone, status)
        VALUES (?, 'owner', ?, ?, ?, 'pending')
      `, [tenantId, name, contact_email, contact_phone]);
    }

    logger.info(`New tenant registered: ${slug}`);

    return success(res, {
      tenant_id: tenantId,
      slug,
      api_key: apiKey,
      status: 'active',
      message: 'Save your API key safely — it will not be shown again!'
    }, 'Tenant registered successfully', 201);
  } catch (err) {
    logger.error('Register tenant failed:', err.message);
    return error(res, err.message);
  }
};

// Get tenant info
const getTenantInfo = async (req, res) => {
  try {
    const tenant = req.tenant;

    const [vendors] = await pool.query('SELECT COUNT(*) as count FROM vendors WHERE tenant_id = ?', [tenant.id]);
    const [products] = await pool.query('SELECT COUNT(*) as count FROM products WHERE tenant_id = ?', [tenant.id]);
    const [orders] = await pool.query('SELECT COUNT(*) as count FROM ondc_orders WHERE tenant_id = ?', [tenant.id]);

    // Fetch active API key
    const [apiKeys] = await pool.query(
      'SELECT key_value FROM api_keys WHERE tenant_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1',
      [tenant.id]
    );

    // Fetch ONDC config
    const [ondcRows] = await pool.query(
      'SELECT * FROM tenant_ondc_config WHERE tenant_id = ? AND is_active = 1 LIMIT 1',
      [tenant.id]
    );
    const ondcConfig = ondcRows[0] || null;

    return success(res, {
      ...tenant,
      api_key: apiKeys[0]?.key_value || null,
      ondc: ondcConfig ? {
        subscriber_id:   ondcConfig.subscriber_id,
        subscriber_url:  ondcConfig.subscriber_url,
        unique_key_id:   ondcConfig.unique_key_id,
        environment:     ondcConfig.ondc_env,
        key_valid_from:  ondcConfig.key_valid_from,
        key_valid_until: ondcConfig.key_valid_until,
        connected:       true,
      } : null,
      stats: {
        vendors: vendors[0].count,
        products: products[0].count,
        orders: orders[0].count
      }
    });
  } catch (err) {
    logger.error('Get tenant info failed:', err.message);
    return error(res, err.message);
  }
};

module.exports = { registerTenant, getTenantInfo };
