require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const logger = require('./src/utils/logger');
const { connectDB } = require('./src/config/database');
const { handleSearch, handleConfirm, handleACK } = require('./src/controllers/ondc.controller');

const app = express();
const PORT = process.env.PORT || 4000;

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Too many requests' }
});

app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/', limiter);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ONDC Connector',
    version: '1.0.0',
    subscriber_id: process.env.ONDC_SUBSCRIBER_ID,
    env: process.env.ONDC_ENV,
    timestamp: new Date().toISOString()
  });
});

// ONDC subscribe verification
app.get('/on_subscribe', (req, res) => {
  res.json({ status: 'ok', subscriber_id: process.env.ONDC_SUBSCRIBER_ID });
});

// ONDC Gateway endpoints (root level)
app.post('/search', handleSearch);
app.post('/on_search', handleACK('on_search'));
app.post('/init', handleACK('init'));
app.post('/on_init', handleACK('on_init'));
app.post('/confirm', handleConfirm);
app.post('/on_confirm', handleACK('on_confirm'));
app.post('/status', handleACK('status'));
app.post('/on_status', handleACK('on_status'));
app.post('/cancel', handleACK('cancel'));
app.post('/on_cancel', handleACK('on_cancel'));
app.post('/update', handleACK('update'));
app.post('/on_update', handleACK('on_update'));
app.post('/track', handleACK('track'));
app.post('/on_track', handleACK('on_track'));
app.post('/support', handleACK('support'));
app.post('/rating', handleACK('rating'));
app.post('/issue', handleACK('issue'));
app.post('/issue_status', handleACK('issue_status'));

// API v1 Routes
app.use('/api/v1/tenant', require('./src/routes/tenant.routes'));
app.use('/api/v1/vendors', require('./src/routes/vendor.routes'));
app.use('/api/v1/catalog', require('./src/routes/catalog.routes'));
app.use('/api/v1/orders', require('./src/routes/order.routes'));
app.use('/api/v1/webhooks', require('./src/routes/webhook.routes'));
app.use('/api/v1/dashboard', require('./src/routes/dashboard.routes'));
app.use('/api/v1/ondc', require('./src/routes/ondc.routes'));

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const start = async () => {
  await connectDB();
  app.listen(PORT, () => {
    logger.info(`ONDC Connector v1.0 running on port ${PORT}`);
    logger.info(`Subscriber ID: ${process.env.ONDC_SUBSCRIBER_ID}`);
    logger.info(`Environment: ${process.env.ONDC_ENV}`);
  });
};

start();
module.exports = app;
