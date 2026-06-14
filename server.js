require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const logger     = require('./src/utils/logger');
const { connectDB } = require('./src/config/database');
const {
  handleSearch,
  handleSelect,
  handleInit,
  handleConfirm,
  handleStatus,
  handleCancel,
  handleUpdate,
  handleTrack,
  handleSupport,
  handleRating,
  handleIssue,
  handleIssueStatus,
  handleACK,
  triggerMerchantUpdate,
  triggerMerchantReturnUpdate,
  triggerMerchantCancel,
  triggerMerchantStatus,
  triggerMerchantStatusSequence,
  triggerIssueResolve,
} = require('./src/controllers/ondc.controller');

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── Middleware ───────────────────────────────────────────────────────────────
const limiter = rateLimit({ windowMs: 60 * 1000, max: 300, message: { error: 'Too many requests' } });

app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/', limiter);

// ─── Health / verification ────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status:        'ok',
  service:       'ONDC Connector',
  version:       '1.0.0',
  subscriber_id: process.env.ONDC_SUBSCRIBER_ID,
  env:           process.env.ONDC_ENV,
  timestamp:     new Date().toISOString(),
}));

// ONDC subscription challenge-response
// Registry calls this with an encrypted challenge; we decrypt and return the answer
app.get('/on_subscribe', (req, res) => {
  try {
    const challenge = req.query.challenge;
    if (!challenge) {
      return res.json({ status: 'ok', subscriber_id: process.env.ONDC_SUBSCRIBER_ID });
    }

    // Decrypt challenge using encryption private key (X25519 + AES)
    const encPrivKey = process.env.ONDC_ENCRYPTION_PRIVATE_KEY;
    if (!encPrivKey) {
      logger.warn('/on_subscribe: ONDC_ENCRYPTION_PRIVATE_KEY not set');
      return res.json({ answer: challenge }); // Echo fallback (not secure)
    }

    try {
      // AES-256-ECB decrypt with key derived from encryption private key
      const keyBuf    = Buffer.from(encPrivKey, 'base64').slice(0, 32);
      const decipher  = require('crypto').createDecipheriv('aes-256-ecb', keyBuf, null);
      decipher.setAutoPadding(false);
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(challenge, 'base64')),
        decipher.final(),
      ]).toString('utf8').replace(/\0+$/, '');
      return res.json({ answer: decrypted });
    } catch (e) {
      logger.warn('/on_subscribe decrypt failed:', e.message);
      return res.json({ answer: challenge });
    }
  } catch (err) {
    logger.error('/on_subscribe error:', err.message);
    return res.status(500).json({ error: 'on_subscribe failed' });
  }
});

// ─── ONDC Gateway endpoints (root-level, no auth) ────────────────────────────
app.post('/search',       handleSearch);
app.post('/select',       handleSelect);
app.post('/init',         handleInit);
app.post('/confirm',      handleConfirm);
app.post('/status',       handleStatus);
app.post('/cancel',       handleCancel);
app.post('/track',        handleTrack);
app.post('/support',      handleSupport);
app.post('/rating',       handleRating);
app.post('/issue',        handleIssue);
app.post('/issue_status', handleIssueStatus);
app.post('/update',       handleUpdate);

// Merchant-initiated trigger endpoints (for Flow 3A/3B/3C testing)
app.post('/trigger/merchant-update/:order_id',           triggerMerchantUpdate);
app.post('/trigger/merchant-return-update/:order_id',    triggerMerchantReturnUpdate);
app.post('/trigger/merchant-cancel/:order_id',           triggerMerchantCancel);
app.post('/trigger/merchant-status/:order_id',           triggerMerchantStatus);
app.post('/trigger/merchant-status-sequence/:order_id',  triggerMerchantStatusSequence);
app.post('/trigger/issue-resolve/:issue_id',             triggerIssueResolve);

// GCR catalog validation feedback
app.post('/catalog_rejection', (req, res) => {
  logger.warn(`GCR catalog_rejection: ${JSON.stringify(req.body)}`);
  res.json({ message: { ack: { status: 'ACK' } } });
});

// Callbacks we may receive from BAP (just ACK)
app.post('/on_search',       handleACK('on_search'));
app.post('/on_select',       handleACK('on_select'));
app.post('/on_init',         handleACK('on_init'));
app.post('/on_confirm',      handleACK('on_confirm'));
app.post('/on_status',       handleACK('on_status'));
app.post('/on_cancel',       handleACK('on_cancel'));
app.post('/on_track',        handleACK('on_track'));
app.post('/on_update',       handleACK('on_update'));
app.post('/on_support',      handleACK('on_support'));
app.post('/on_rating',       handleACK('on_rating'));
app.post('/on_issue',        handleACK('on_issue'));
app.post('/on_issue_status', handleACK('on_issue_status'));

// ─── API v1 routes ────────────────────────────────────────────────────────────
app.use('/api/v1/tenant',      require('./src/routes/tenant.routes'));
app.use('/api/v1/vendors',     require('./src/routes/vendor.routes'));
app.use('/api/v1/catalog',     require('./src/routes/catalog.routes'));
app.use('/api/v1/orders',      require('./src/routes/order.routes'));
app.use('/api/v1/webhooks',    require('./src/routes/webhook.routes'));
app.use('/api/v1/dashboard',   require('./src/routes/dashboard.routes'));
app.use('/api/v1/ondc',        require('./src/routes/ondc.routes'));
app.use('/api/v1/settlements', require('./src/routes/settlement.routes'));
app.use('/api/v1/igm',         require('./src/routes/igm.routes'));

// ─── Error handlers ───────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Startup migrations ───────────────────────────────────────────────────────
const runMigrations = async () => {
  const { pool } = require('./src/config/database');
  try {
    // Add std_city_code column if not present
    await pool.query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS std_city_code VARCHAR(20) NULL`);
    // Populate std_city_code from pincode for known mappings
    await pool.query(`
      UPDATE vendors SET std_city_code = CASE
        WHEN pincode LIKE '6%' THEN 'std:044'
        WHEN pincode LIKE '56%' OR pincode LIKE '57%' OR pincode LIKE '58%' THEN 'std:080'
        WHEN pincode LIKE '4%' THEN 'std:022'
        WHEN pincode LIKE '11%' THEN 'std:011'
        WHEN pincode LIKE '70%' THEN 'std:033'
        WHEN pincode LIKE '50%' THEN 'std:040'
        ELSE NULL
      END
      WHERE std_city_code IS NULL AND pincode IS NOT NULL AND pincode != ''
    `);
    logger.info('DB migrations complete');
  } catch (e) {
    logger.warn('Migration warning:', e.message);
  }
};

// ─── Start ────────────────────────────────────────────────────────────────────
const start = async () => {
  await connectDB();
  await runMigrations();

  // Start background scheduler jobs
  try {
    const { startAllJobs } = require('./src/jobs/index');
    startAllJobs();
  } catch (e) {
    logger.warn('Scheduler jobs failed to start:', e.message);
  }

  app.listen(PORT, () => {
    logger.info(`ONDC Connector v1.0 running on port ${PORT}`);
    logger.info(`Subscriber ID: ${process.env.ONDC_SUBSCRIBER_ID}`);
    logger.info(`Environment:   ${process.env.ONDC_ENV}`);
  });
};

start();
module.exports = app;
