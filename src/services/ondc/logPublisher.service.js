const axios = require('axios');
const logger = require('../../utils/logger');

const ANALYTICS_URL =
  process.env.ONDC_ANALYTICS_URL ||
  'https://analytics-api-pre-prod.aws.ondc.org/v1/api/push-txn-logs';

const getAnalyticsToken = () => {
  const raw = process.env.ONDC_ANALYTICS_TOKEN;
  if (!raw) return null;
  return raw.trim().replace(/^Bearer\s+/i, '');
};

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

const enrichLogData = (data) => {
  if (!data?.context) return data;
  return {
    ...data,
    context: {
      ...data.context,
      bpp_id:  data.context.bpp_id  || process.env.ONDC_SUBSCRIBER_ID,
      bpp_uri: data.context.bpp_uri || process.env.ONDC_SUBSCRIBER_URL,
    },
  };
};

const pushTxnLogWithAuth = async (payload, authHeader, retries = 1) => {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(ANALYTICS_URL, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        timeout: 15000,
        validateStatus: (s) => s < 500,
      });

      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status, data: response.data };
      }

      const detail = typeof response.data === 'object'
        ? JSON.stringify(response.data).slice(0, 500)
        : String(response.data || response.statusText);
      lastError = { status: response.status, error: detail };
    } catch (err) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data).slice(0, 500)
        : err.message;
      lastError = { status: err.response?.status, error: detail };
    }
  }
  return { ok: false, ...lastError };
};

// Push one transaction log entry to ONDC Network Observability.
// type examples: "select", "select_response", "on_select", "init_response", etc.
const pushTxnLog = async (type, data, retries = 3) => {
  const token = getAnalyticsToken();
  if (!token) {
    return { ok: false, error: 'ONDC_ANALYTICS_TOKEN not set' };
  }
  if (!type || !data) {
    return { ok: false, error: 'missing type or data' };
  }

  const payload = { type, data: scrubPII(enrichLogData(data)) };
  const authHeaders = [
    `Bearer ${token}`,
    token,
  ];

  let lastError = null;
  for (const authHeader of authHeaders) {
    const result = await pushTxnLogWithAuth(payload, authHeader, retries);
    if (result.ok) {
      logger.info(`ONDC txn log pushed: ${type}`, {
        txn: data?.context?.transaction_id,
        msg: data?.context?.message_id,
        status: result.status,
        body: typeof result.data === 'object' ? JSON.stringify(result.data).slice(0, 200) : result.data,
      });
      return result;
    }
    lastError = result;
    if (result.status !== 401) break;
  }

  logger.error(
    `ONDC txn log push FAILED (${type}) after ${retries} attempts [${lastError?.status || 'no-response'}]: ${lastError?.error}`,
    { txn: data?.context?.transaction_id, subscriber: process.env.ONDC_SUBSCRIBER_ID }
  );
  return { ok: false, ...lastError };
};

const isLogPublisherConfigured = () => Boolean(getAnalyticsToken());

const decodeJwtPayload = (token) => {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const getTokenDiagnostics = () => {
  const raw = process.env.ONDC_ANALYTICS_TOKEN;
  if (!raw) return { configured: false };
  const trimmed = raw.trim();
  const token = trimmed.replace(/^Bearer\s+/i, '');
  const claims = decodeJwtPayload(token);
  const now = Math.floor(Date.now() / 1000);

  const diag = {
    configured: true,
    length: token.length,
    looks_like_jwt: token.startsWith('eyJ'),
    has_wrapping_quotes: /^["']/.test(trimmed) || /["']$/.test(trimmed),
    has_whitespace: /\s/.test(token),
    subscriber_id: process.env.ONDC_SUBSCRIBER_ID || null,
  };

  if (claims) {
    const exp = claims.exp;
    const tokenSubscriber =
      claims.subscriber_id || claims.subscriberId || claims.sub || claims.np_id || claims.npId || null;
    diag.jwt = {
      subscriber_in_token: tokenSubscriber,
      issuer: claims.iss || null,
      expires_at: exp ? new Date(exp * 1000).toISOString() : null,
      expired: exp ? exp < now : null,
      env: claims.env || claims.environment || null,
    };
    if (tokenSubscriber && diag.subscriber_id && tokenSubscriber !== diag.subscriber_id) {
      diag.jwt.subscriber_mismatch = true;
    }
  }

  return diag;
};

// Live probe — call from /health/analytics or startup
const testAnalyticsPush = async () => {
  const sample = {
    context: {
      domain: 'ONDC:RET10',
      country: 'IND',
      city: 'std:080',
      action: 'select',
      core_version: '1.2.0',
      bap_id: 'pramaan.ondc.org/beta/preprod/mock/buyer',
      bap_uri: 'https://pramaan.ondc.org/beta/preprod/mock/buyer',
      bpp_id: process.env.ONDC_SUBSCRIBER_ID || 'ondc.cottkart.com',
      bpp_uri: process.env.ONDC_SUBSCRIBER_URL || 'https://ondc.cottkart.com',
      transaction_id: `health-probe-${Date.now()}`,
      message_id: `health-probe-${Date.now()}`,
      timestamp: new Date().toISOString(),
      ttl: 'PT30S',
    },
    message: { ack: { status: 'ACK' } },
  };
  return pushTxnLog('select_response', sample, 1);
};

module.exports = {
  pushTxnLog,
  scrubPII,
  isLogPublisherConfigured,
  testAnalyticsPush,
  getAnalyticsToken,
  getTokenDiagnostics,
};
