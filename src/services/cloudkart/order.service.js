const axios = require('axios');
const logger = require('../../utils/logger');
const { mapONDCOrderToCloudKart } = require('../../utils/ondcMapper');

const CLOUDKART_API_URL = process.env.CLOUDKART_API_URL;
const CLOUDKART_API_KEY = process.env.CLOUDKART_API_KEY;

const headers = () => ({
  'Content-Type': 'application/json',
  'X-API-Key': CLOUDKART_API_KEY
});

// Create order in CloudKart
const createOrder = async (ondcOrder) => {
  try {
    const orderData = mapONDCOrderToCloudKart(ondcOrder);
    const response = await axios.post(`${CLOUDKART_API_URL}/api/orders`, orderData, { headers: headers() });
    logger.info(`Order created in CloudKart: ${response.data?.id}`);
    return response.data;
  } catch (error) {
    logger.error('CloudKart order creation failed:', error.message);
    throw error;
  }
};

// Update order status in CloudKart
const updateOrderStatus = async (orderId, status) => {
  try {
    const response = await axios.patch(`${CLOUDKART_API_URL}/api/orders/${orderId}`, { status }, { headers: headers() });
    return response.data;
  } catch (error) {
    logger.error(`CloudKart order update failed for ${orderId}:`, error.message);
    throw error;
  }
};

module.exports = { createOrder, updateOrderStatus };
