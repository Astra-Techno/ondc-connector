const axios = require('axios');
const logger = require('../../utils/logger');

const CLOUDKART_API_URL = process.env.CLOUDKART_API_URL;
const CLOUDKART_API_KEY = process.env.CLOUDKART_API_KEY;

const headers = () => ({
  'Content-Type': 'application/json',
  'X-API-Key': CLOUDKART_API_KEY,
});

// Push ONDC order to CottKart
const pushOrder = async (ondcPayload) => {
  try {
    const order   = ondcPayload?.message?.order || ondcPayload;
    const context = ondcPayload?.context        || {};

    const orderData = {
      ondc_order_id:       order.id,
      ondc_transaction_id: context.transaction_id,
      buyer_name:          order.billing?.name,
      buyer_phone:         order.billing?.phone,
      buyer_email:         order.billing?.email,
      delivery_address:    order.fulfillments?.[0]?.end?.location?.address,
      items: (order.items || []).map(item => ({
        product_id: item.id,
        quantity:   item.quantity?.count || 1,
        price:      item.price?.value,
      })),
      payment_type:  order.payment?.type  || 'ON-ORDER',
      total_amount:  order.quote?.price?.value,
    };

    const response = await axios.post(`${CLOUDKART_API_URL}/api/ondc/orders`, orderData, {
      headers: headers(),
      timeout: 30000,
    });
    const result = response.data?.data || response.data;
    logger.info(`Order pushed to CottKart: ${result?.id || result?.order_id}`);
    return result;
  } catch (err) {
    logger.error('pushOrder failed:', err.message);
    throw err;
  }
};

// Fetch order status from CottKart
const fetchOrderStatus = async (cottKartOrderId) => {
  try {
    const response = await axios.get(`${CLOUDKART_API_URL}/api/orders/${cottKartOrderId}`, {
      headers: headers(),
      timeout: 30000,
    });
    return response.data?.data || response.data;
  } catch (err) {
    logger.error(`fetchOrderStatus(${cottKartOrderId}) failed:`, err.message);
    throw err;
  }
};

// Cancel order in CottKart
const cancelOrder = async (cottKartOrderId, reason) => {
  try {
    const response = await axios.put(
      `${CLOUDKART_API_URL}/api/orders/${cottKartOrderId}/status`,
      { status: 'cancelled', reason },
      { headers: headers(), timeout: 30000 }
    );
    return response.data?.data || response.data;
  } catch (err) {
    logger.error(`cancelOrder(${cottKartOrderId}) failed:`, err.message);
    throw err;
  }
};

// Fetch shipment tracking info from CottKart
const fetchTrackingInfo = async (cottKartOrderId) => {
  try {
    const response = await axios.get(
      `${CLOUDKART_API_URL}/api/orders/${cottKartOrderId}/tracking`,
      { headers: headers(), timeout: 30000 }
    );
    return response.data?.data || response.data;
  } catch (err) {
    logger.error(`fetchTrackingInfo(${cottKartOrderId}) failed:`, err.message);
    return null; // Tracking may not be available yet
  }
};

// Legacy aliases
const createOrder = pushOrder;
const updateOrderStatus = async (orderId, status) => {
  try {
    const response = await axios.patch(
      `${CLOUDKART_API_URL}/api/orders/${orderId}`,
      { status },
      { headers: headers(), timeout: 30000 }
    );
    return response.data;
  } catch (err) {
    logger.error(`updateOrderStatus(${orderId}) failed:`, err.message);
    throw err;
  }
};

module.exports = {
  pushOrder, fetchOrderStatus, cancelOrder, fetchTrackingInfo,
  createOrder, updateOrderStatus,
};
