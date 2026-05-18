const axios = require('axios');
const logger = require('../../utils/logger');

const CLOUDKART_API_URL = process.env.CLOUDKART_API_URL;
const CLOUDKART_API_KEY = process.env.CLOUDKART_API_KEY;

const headers = () => ({
  'Content-Type': 'application/json',
  'X-API-Key': CLOUDKART_API_KEY
});

// Fetch products from CloudKart
const getProducts = async (vendorId = null, page = 1, limit = 50) => {
  try {
    const params = { page, limit };
    if (vendorId) params.vendor_id = vendorId;
    const response = await axios.get(`${CLOUDKART_API_URL}/api/products`, { params, headers: headers() });
    return response.data;
  } catch (error) {
    logger.error('CloudKart products fetch failed:', error.message);
    throw error;
  }
};

// Fetch categories from CloudKart
const getCategories = async () => {
  try {
    const response = await axios.get(`${CLOUDKART_API_URL}/api/categories`, { headers: headers() });
    return response.data;
  } catch (error) {
    logger.error('CloudKart categories fetch failed:', error.message);
    throw error;
  }
};

module.exports = { getProducts, getCategories };
