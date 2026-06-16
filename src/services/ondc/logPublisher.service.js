const axios = require('axios');
const logger = require('../../utils/logger');

const ANALYTICS_URL =
  process.env.ONDC_ANALYTICS_URL ||
  'https://analytics-api.aws.ondc.org/v1/api/push-txn-logs';
const ANALYTICS_TOKEN = process.env.ONDC_ANALYTICS_TOKEN;

// Scrub PII before pushing to ONDC observability (required by spec)
const scrubPII = (payload) => {
  if (!payload || typeof payload !== 'object') return payload;
  const clone = JSON.parse(JSON.stringify(payload));

  const scrubOrder = (order) => {
    if (!order) return;
    if (order.billing) {
      if (order.billing.phone) order.billing.phone = '9999999999';
      if (order.billing.email) order.billing.email = 'buyer@example.com';
      if (order.billing.name) order.billing.name = 'Buyer';
      if (order.billing.address?.building) order.billing.address.building = 'XXX';
    }
    for (const f of order.fulfillments || []) {
      if (f.end?.contact?.phone) f.end.contact.phone = '9999999999';
      if (f.end?.contact?.email) f.end.contact.email = 'buyer@example.com';
      if (f.end?.location?.address?.name) f.end.location.address.name = 'Buyer';
    }
  };

  if (clone.message?.order) scrubOrder(clone.message.order);
  return clone;
};

// Push one transaction log entry to ONDC Network Observability.
// type examples: "select", "select_response", "on_select", "init_response", etc.
const pushTxnLog = async (type, data) => {
  if (!ANALYTICS_TOKEN) return;
  if (!type || !data) return;

  try {
    await axios.post(
      ANALYTICS_URL,
      { type, data: scrubPII(data) },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ANALYTICS_TOKEN}`,
        },
        timeout: 10000,
      }
    );
    logger.info(`ONDC txn log pushed: ${type}`, {
      txn: data?.context?.transaction_id,
      msg: data?.context?.message_id,
    });
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data).slice(0, 200)
      : err.message;
    logger.warn(`ONDC txn log push failed (${type}): ${detail}`);
  }
};

const isLogPublisherConfigured = () => Boolean(ANALYTICS_TOKEN);

module.exports = { pushTxnLog, scrubPII, isLogPublisherConfigured };
