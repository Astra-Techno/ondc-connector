const axios = require('axios');
const { createAuthHeader } = require('../../utils/crypto');
const logger = require('../../utils/logger');

const REGISTRY_URL = process.env.ONDC_REGISTRY_URL;
const SUBSCRIBER_ID = process.env.ONDC_SUBSCRIBER_ID;
const UNIQUE_KEY_ID = process.env.ONDC_UNIQUE_KEY_ID;
const SIGNING_PRIVATE_KEY = process.env.ONDC_SIGNING_PRIVATE_KEY;

// Make authenticated ONDC API call
const callONDC = async (url, body) => {
  try {
    const authHeader = createAuthHeader(SIGNING_PRIVATE_KEY, SUBSCRIBER_ID, UNIQUE_KEY_ID, body);
    const response = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      timeout: 30000
    });
    return response.data;
  } catch (error) {
    logger.error(`ONDC API call failed to ${url}:`, error.message);
    throw error;
  }
};

// Lookup subscriber in ONDC registry
const lookupSubscriber = async (subscriberId) => {
  try {
    const response = await axios.post(`${REGISTRY_URL}/lookup`, {
      subscriber_id: subscriberId
    });
    return response.data;
  } catch (error) {
    logger.error('Registry lookup failed:', error.message);
    throw error;
  }
};

module.exports = { callONDC, lookupSubscriber };
