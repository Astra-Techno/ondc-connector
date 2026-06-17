#!/usr/bin/env node
/**
 * Test ONDC Network Observability log push.
 * Usage (on VPS): node scripts/test-ondc-log-push.js
 * Requires ONDC_ANALYTICS_TOKEN in .env
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { isLogPublisherConfigured, testAnalyticsPush } = require('../src/services/ondc/logPublisher.service');

(async () => {
  if (!isLogPublisherConfigured()) {
    console.error('FAIL: ONDC_ANALYTICS_TOKEN is not set in .env');
    process.exit(1);
  }
  console.log('Pushing test select_response log to ONDC analytics API...');
  const result = await testAnalyticsPush();
  if (result.ok) {
    console.log('SUCCESS:', result.status, JSON.stringify(result.data || {}));
    process.exit(0);
  }
  console.error('FAILED:', result.status || '', result.error);
  process.exit(1);
})();
