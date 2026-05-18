const { pool } = require('../config/database');
const { ack, nack } = require('../utils/response');
const { saveONDCOrder } = require('./order.controller');
const logger = require('../utils/logger');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// Get all active tenants with their ONDC config
const getActiveTenants = async () => {
  const [tenants] = await pool.query(`
    SELECT t.*, oc.subscriber_id, oc.subscriber_url,
           oc.signing_private_key, oc.unique_key_id
    FROM tenants t
    JOIN tenant_ondc_config oc ON oc.tenant_id = t.id
    WHERE t.status = 'active' AND oc.is_active = 1
  `);
  return tenants;
};

// Build ONDC catalog from DB for a tenant
const buildCatalog = async (tenantId, ondcConfig) => {
  try {
    const [vendors] = await pool.query(`
      SELECT v.* FROM vendors v
      WHERE v.tenant_id = ? AND v.status = 'active'
    `, [tenantId]);

    const providers = [];

    for (const vendor of vendors) {
      const [products] = await pool.query(`
        SELECT * FROM products
        WHERE tenant_id = ? AND vendor_id = ? AND is_active = 1 AND stock > 0
        LIMIT 100
      `, [tenantId, vendor.id]);

      if (products.length === 0) continue;

      const items = products.map(p => ({
        id: p.external_product_id,
        descriptor: {
          name: p.name,
          short_desc: p.short_description || p.name,
          long_desc: p.description || p.name,
          images: p.images ? JSON.parse(p.images).map(url => ({ url })) :
                  p.image_url ? [{ url: p.image_url }] : []
        },
        price: {
          currency: p.currency || 'INR',
          value: String(p.price),
          maximum_value: String(p.mrp || p.price)
        },
        quantity: {
          available: { count: String(p.stock || 0) },
          maximum: { count: '10' }
        },
        category_id: 'grocery',
        fulfillment_id: 'f1',
        location_id: 'l1',
        '@ondc/org/returnable': p.is_returnable === 1,
        '@ondc/org/cancellable': p.is_cancellable === 1,
        '@ondc/org/return_window': p.return_window || 'P1D',
        '@ondc/org/seller_pickup_return': false,
        '@ondc/org/time_to_ship': p.time_to_ship || 'PT24H',
        '@ondc/org/available_on_cod': p.available_on_cod === 1,
        '@ondc/org/contact_details_consumer_care': vendor.phone || '',
        '@ondc/org/statutory_reqs_packaged_commodities': {
          manufacturer_or_packer_name: vendor.business_name,
          manufacturer_or_packer_address: `${vendor.address || ''}, ${vendor.city || ''}`,
          common_or_generic_name_of_commodity: p.name,
          net_quantity_or_measure_of_commodity_in_pkg: '1',
          month_year_of_manufacture_packing_import: new Date().toISOString().substring(0, 7)
        }
      }));

      providers.push({
        id: vendor.external_vendor_id || String(vendor.id),
        descriptor: {
          name: vendor.business_name,
          short_desc: vendor.business_name,
          images: vendor.logo_url ? [{ url: vendor.logo_url }] : []
        },
        '@ondc/org/fssai_license_no': vendor.fssai_number || '',
        locations: [{
          id: 'l1',
          gps: vendor.gps || '13.0827,80.2707',
          address: {
            locality: vendor.address || vendor.city,
            city: vendor.city || 'Chennai',
            state: vendor.state || 'Tamil Nadu',
            country: 'IND',
            area_code: vendor.pincode || '600001'
          },
          time: {
            label: 'enable',
            timestamp: new Date().toISOString(),
            days: '1,2,3,4,5,6,7',
            schedule: { holidays: [] },
            range: { start: '0900', end: '2100' }
          },
          circle: {
            gps: vendor.gps || '13.0827,80.2707',
            radius: { unit: 'km', value: '10' }
          }
        }],
        items,
        fulfillments: [{
          id: 'f1',
          type: 'Delivery',
          contact: {
            phone: vendor.phone || '',
            email: vendor.email || ''
          }
        }],
        payment_methods: [{
          '@ondc/org/buyer_app_finder_fee_type': 'percent',
          '@ondc/org/buyer_app_finder_fee_amount': '3'
        }]
      });
    }

    return providers.length > 0 ? {
      'bpp/descriptor': {
        name: ondcConfig?.subscriber_id || 'ONDC Connector',
        short_desc: 'ONDC Seller Platform'
      },
      'bpp/providers': providers
    } : null;
  } catch (err) {
    logger.error('Build catalog failed:', err.message);
    return null;
  }
};

// Send on_search callback to BAP
const sendOnSearch = async (context, catalog, ondcConfig) => {
  try {
    const callbackUrl = `${context.bap_uri}/on_search`;
    const payload = {
      context: {
        ...context,
        action: 'on_search',
        bpp_id: ondcConfig?.subscriber_id,
        bpp_uri: ondcConfig?.subscriber_url,
        timestamp: new Date().toISOString(),
        message_id: uuidv4()
      },
      message: { catalog }
    };

    logger.info(`Sending on_search to: ${callbackUrl}`);
    const response = await axios.post(callbackUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    logger.info(`on_search sent to ${callbackUrl}: ${response.status}`);
    return response.data;
  } catch (err) {
    logger.error(`on_search callback failed to ${context.bap_uri}:`, err.message);
  }
};

// Handle /search from ONDC
const handleSearch = async (req, res) => {
  try {
    const body = req.body;
    const context = body.context;

    logger.info('ONDC /search received', {
      bap_id: context?.bap_id,
      city: context?.city,
      domain: context?.domain
    });

    // Send ACK immediately
    res.json({ message: { ack: { status: 'ACK' } } });

    // Get ALL active tenants
    const tenants = await getActiveTenants();

    if (!tenants.length) {
      logger.info('No active tenants found');
      return;
    }

    // Send catalog for each tenant
    for (const tenant of tenants) {
      const ondcConfig = {
        subscriber_id: tenant.subscriber_id,
        subscriber_url: tenant.subscriber_url
      };

      const catalog = await buildCatalog(tenant.id, ondcConfig);

      if (catalog && catalog['bpp/providers']?.length > 0) {
        logger.info(`Sending catalog for tenant: ${tenant.slug} with ${catalog['bpp/providers'].length} providers`);
        await sendOnSearch(context, catalog, ondcConfig);
      } else {
        logger.info(`No active products for tenant: ${tenant.slug}`);
      }
    }
  } catch (err) {
    logger.error('Search handler failed:', err.message);
  }
};

// Handle /confirm
const handleConfirm = async (req, res) => {
  try {
    logger.info('ONDC /confirm received');
    res.json({ message: { ack: { status: 'ACK' } } });
    const tenants = await getActiveTenants();
    if (tenants.length) {
      await saveONDCOrder(tenants[0].id, req.body, req.body);
    }
  } catch (err) {
    logger.error('Confirm handler failed:', err.message);
  }
};

// Generic ACK handler
const handleACK = (action) => async (req, res) => {
  logger.info(`ONDC /${action} received`, { context: req.body?.context });
  res.json({ message: { ack: { status: 'ACK' } } });
};

module.exports = { handleSearch, handleConfirm, handleACK };
