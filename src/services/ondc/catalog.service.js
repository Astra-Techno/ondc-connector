const { callONDC } = require('./auth.service');
const { mapProductToONDC } = require('../../utils/ondcMapper');
const logger = require('../../utils/logger');
const { v4: uuidv4 } = require('uuid');

const SUBSCRIBER_ID = process.env.ONDC_SUBSCRIBER_ID;
const SUBSCRIBER_URL = process.env.ONDC_SUBSCRIBER_URL;
const GATEWAY_URL = process.env.ONDC_GATEWAY_URL;

// Push catalog to ONDC
const pushCatalog = async (vendor, products) => {
  try {
    const ondcItems = products.map(p => mapProductToONDC(p, vendor));
    const payload = {
      context: {
        domain: process.env.ONDC_DOMAIN || 'ONDC:RET10',
        action: 'on_search',
        country: 'IND',
        city: '*',
        core_version: '1.2.0',
        bap_id: SUBSCRIBER_ID,
        bap_uri: SUBSCRIBER_URL,
        bpp_id: SUBSCRIBER_ID,
        bpp_uri: SUBSCRIBER_URL,
        transaction_id: uuidv4(),
        message_id: uuidv4(),
        timestamp: new Date().toISOString(),
        ttl: 'PT30S'
      },
      message: {
        catalog: {
          'bpp/descriptor': {
            name: vendor.business_name,
            short_desc: vendor.business_name
          },
          'bpp/providers': [{
            id: String(vendor.id),
            descriptor: { name: vendor.business_name },
            locations: [{
              id: 'l1',
              gps: vendor.gps || '12.9716,77.5946',
              address: { city: vendor.city || 'Chennai', state: 'Tamil Nadu' }
            }],
            items: ondcItems,
            fulfillments: [{
              id: 'f1',
              type: 'Delivery',
              contact: { phone: vendor.phone || '', email: vendor.email || '' }
            }]
          }]
        }
      }
    };
    const result = await callONDC(`${GATEWAY_URL}/search`, payload);
    logger.info(`Catalog pushed for vendor ${vendor.id}`);
    return result;
  } catch (error) {
    logger.error(`Catalog push failed for vendor ${vendor.id}:`, error.message);
    throw error;
  }
};

module.exports = { pushCatalog };
