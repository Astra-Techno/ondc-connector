const { pool } = require('../config/database');
const logger = require('../utils/logger');

const resolveTenant = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
      return res.status(401).json({ success: false, message: 'API key required' });
    }

    const [rows] = await pool.query(`
      SELECT t.* FROM tenants t
      JOIN api_keys ak ON ak.tenant_id = t.id
      WHERE ak.key_value = ? AND ak.is_active = 1 AND t.status = 'active'
    `, [apiKey]);

    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid API key' });
    }

    req.tenant = rows[0];

    const [configRows] = await pool.query(
      'SELECT * FROM tenant_ondc_config WHERE tenant_id = ? AND is_active = 1',
      [rows[0].id]
    );
    req.ondcConfig = configRows[0] || null;

    next();
  } catch (err) {
    logger.error('Tenant middleware failed:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = { resolveTenant };
