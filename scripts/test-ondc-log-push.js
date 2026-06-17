#!/usr/bin/env node
/**
 * Test ONDC Network Observability log push.
 * Usage (on VPS): node scripts/test-ondc-log-push.js
 * Requires ONDC_ANALYTICS_TOKEN in .env
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pushTxnLog, isLogPublisherConfigured } = require('../src/services/ondc/logPublisher.service');

const sampleAck = {
  context: {
    domain: 'ONDC:RET10',
    country: 'IND',
    city: 'std:080',
    action: 'select',
    core_version: '1.2.5',
    bap_id: 'pramaan.ondc.org/beta/preprod/mock/buyer',
    bap_uri: 'https://pramaan.ondc.org/beta/preprod/mock/buyer',
    bpp_id: process.env.ONDC_SUBSCRIBER_ID || 'ondc.cottkart.com',
    bpp_uri: process.env.ONDC_SUBSCRIBER_URL || 'https://ondc.cottkart.com',
    transaction_id: `test-${Date.now()}`,
    message_id: `msg-${Date.now()}`,
    timestamp: new Date().toISOString(),
    ttl: 'PT30S',
  },
  message: { ack: { status: 'ACK' } },
};

(async () => {
  if (!isLogPublisherConfigured()) {
    console.error('FAIL: ONDC_ANALYTICS_TOKEN is not set in .env');
    process.exit(1);
  }
  console.log('Pushing test select_response log to ONDC analytics API...');
  const result = await pushTxnLog('select_response', sampleAck);
  if (result.ok) {
    console.log('SUCCESS:', result.status, JSON.stringify(result.data || {}));
    process.exit(0);
  }
  console.error('FAILED:', result.status || '', result.error);
  process.exit(1);
})();
