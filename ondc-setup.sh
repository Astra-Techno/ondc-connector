#!/bin/bash

# =============================================================
# ONDC Connector - Complete Project Setup Script
# For: ondc.cottkart.com | VPS: 103.212.120.146
# =============================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[✓] $1${NC}"; }
warn() { echo -e "${YELLOW}[!] $1${NC}"; }
section() { echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${BLUE} $1${NC}"; echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"; }

section "Step 1: Setup Project Directory"
cd /var/www/ondc-connector
npm init -y
log "NPM initialized"

section "Step 2: Install Dependencies"
npm install express dotenv cors helmet morgan uuid axios mysql2 bull ioredis jsonwebtoken bcryptjs joi winston winston-daily-rotate-file node-cron
log "Dependencies installed"

section "Step 3: Create Folder Structure"
mkdir -p src/{config,controllers,middleware,models,routes,services/ondc,services/cloudkart,queue,utils,jobs} logs
log "Folder structure created"

section "Step 4: Create Logger Utility"
cat > src/utils/logger.js << 'EOF'
const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const transport = new winston.transports.DailyRotateFile({
  filename: path.join('logs', 'ondc-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  maxSize: '20m'
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    transport,
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

module.exports = logger;
EOF
log "Logger created"

section "Step 5: Create Database Config"
cat > src/config/database.js << 'EOF'
const mysql = require('mysql2/promise');
const logger = require('../utils/logger');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'ondc_connector_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const connectDB = async () => {
  try {
    const connection = await pool.getConnection();
    logger.info('MySQL connected successfully');
    connection.release();
    return pool;
  } catch (error) {
    logger.error('MySQL connection failed:', error.message);
    setTimeout(connectDB, 5000);
  }
};

module.exports = { pool, connectDB };
EOF
log "Database config created"

section "Step 6: Create Redis Config"
cat > src/config/redis.js << 'EOF'
const Redis = require('ioredis');
const logger = require('../utils/logger');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000)
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error('Redis error:', err.message));

module.exports = redis;
EOF
log "Redis config created"

section "Step 7: Create ONDC Crypto Utility"
cat > src/utils/crypto.js << 'EOF'
const crypto = require('crypto');

// Create Authorization header for ONDC API calls
const createAuthHeader = (signingPrivateKey, subscriberId, uniqueKeyId, body) => {
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const expiry = timestamp + 300;
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64');
    const signingString = `(created): ${timestamp}\n(expires): ${expiry}\ndigest: BLAKE-512=${bodyHash}`;
    const privateKeyBuffer = Buffer.from(signingPrivateKey, 'base64');
    const signature = crypto.sign(null, Buffer.from(signingString), {
      key: privateKeyBuffer,
      format: 'der',
      type: 'pkcs8'
    }).toString('base64');
    return `Signature keyId="${subscriberId}|${uniqueKeyId}|ed25519",algorithm="ed25519",created="${timestamp}",expires="${expiry}",headers="(created) (expires) digest",signature="${signature}"`;
  } catch (error) {
    throw new Error(`Auth header creation failed: ${error.message}`);
  }
};

// Verify incoming ONDC request signature
const verifyAuthHeader = (authHeader, body) => {
  try {
    return true; // Implement full verification as needed
  } catch (error) {
    return false;
  }
};

module.exports = { createAuthHeader, verifyAuthHeader };
EOF
log "Crypto utility created"

section "Step 8: Create Response Helper"
cat > src/utils/response.js << 'EOF'
const success = (res, data, message = 'Success', code = 200) => {
  return res.status(code).json({ success: true, message, data });
};

const error = (res, message = 'Error', code = 500, errors = null) => {
  return res.status(code).json({ success: false, message, errors });
};

const ack = (res, status = 'ACK') => {
  return res.status(200).json({ message: { ack: { status } } });
};

const nack = (res, message = 'NACK') => {
  return res.status(200).json({ message: { ack: { status: 'NACK' }, error: { message } } });
};

module.exports = { success, error, ack, nack };
EOF
log "Response helper created"

section "Step 9: Create ONDC Mapper"
cat > src/utils/ondcMapper.js << 'EOF'
// Map CloudKart product to ONDC item schema
const mapProductToONDC = (product, vendorInfo) => {
  return {
    id: String(product.id),
    descriptor: {
      name: product.name,
      short_desc: product.description || product.name,
      long_desc: product.description || product.name,
      images: product.image_url ? [{ url: product.image_url }] : []
    },
    price: {
      currency: 'INR',
      value: String(product.price),
      maximum_value: String(product.mrp || product.price)
    },
    quantity: {
      available: { count: String(product.stock || 0) },
      maximum: { count: '10' }
    },
    category_id: product.category_slug || 'grocery',
    fulfillment_id: 'f1',
    location_id: 'l1',
    '@ondc/org/returnable': false,
    '@ondc/org/cancellable': true,
    '@ondc/org/return_window': 'P1D',
    '@ondc/org/seller_pickup_return': false,
    '@ondc/org/time_to_ship': 'PT24H',
    '@ondc/org/available_on_cod': true,
    '@ondc/org/contact_details_consumer_care': vendorInfo.contact || '',
    '@ondc/org/statutory_reqs_packaged_commodities': {
      manufacturer_or_packer_name: vendorInfo.business_name || '',
      manufacturer_or_packer_address: vendorInfo.address || '',
      common_or_generic_name_of_commodity: product.name,
      net_quantity_or_measure_of_commodity_in_pkg: '1',
      month_year_of_manufacture_packing_import: new Date().toISOString().substring(0, 7)
    }
  };
};

// Map ONDC order to CloudKart order
const mapONDCOrderToCloudKart = (ondcOrder) => {
  return {
    ondc_order_id: ondcOrder.id,
    items: ondcOrder.items?.map(item => ({
      product_id: item.id,
      quantity: item.quantity?.count || 1,
      price: item.price?.value
    })),
    billing: ondcOrder.billing,
    fulfillment: ondcOrder.fulfillments?.[0],
    payment: ondcOrder.payment,
    total: ondcOrder.quote?.price?.value
  };
};

module.exports = { mapProductToONDC, mapONDCOrderToCloudKart };
EOF
log "ONDC mapper created"

section "Step 10: Create ONDC Auth Service"
cat > src/services/ondc/auth.service.js << 'EOF'
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
EOF
log "ONDC auth service created"

section "Step 11: Create ONDC Catalog Service"
cat > src/services/ondc/catalog.service.js << 'EOF'
const { callONDC } = require('./auth.service');
const { mapProductToONDC } = require('../../utils/ondcMapper');
const logger = require('../../utils/logger');
const { v4: uuidv4 } = require('uuid');

const SUBSCRIBER_ID = process.env.ONDC_SUBSCRIBER_ID;
const SUBSCRIBER_URL = process.env.ONDC_SUBSCRIBER_URL;
const GATEWAY_URL = process.env.ONDC_GATEWAY_URL;

// Push catalog to ONDC
const pushCatalog = async (vendor, products) => {
  try {
    const ondcItems = products.map(p => mapProductToONDC(p, vendor));
    const payload = {
      context: {
        domain: process.env.ONDC_DOMAIN || 'ONDC:RET10',
        action: 'on_search',
        country: 'IND',
        city: '*',
        core_version: '1.2.0',
        bap_id: SUBSCRIBER_ID,
        bap_uri: SUBSCRIBER_URL,
        bpp_id: SUBSCRIBER_ID,
        bpp_uri: SUBSCRIBER_URL,
        transaction_id: uuidv4(),
        message_id: uuidv4(),
        timestamp: new Date().toISOString(),
        ttl: 'PT30S'
      },
      message: {
        catalog: {
          'bpp/descriptor': {
            name: vendor.business_name,
            short_desc: vendor.business_name
          },
          'bpp/providers': [{
            id: String(vendor.id),
            descriptor: { name: vendor.business_name },
            locations: [{
              id: 'l1',
              gps: vendor.gps || '12.9716,77.5946',
              address: { city: vendor.city || 'Chennai', state: 'Tamil Nadu' }
            }],
            items: ondcItems,
            fulfillments: [{
              id: 'f1',
              type: 'Delivery',
              contact: { phone: vendor.phone || '', email: vendor.email || '' }
            }]
          }]
        }
      }
    };
    const result = await callONDC(`${GATEWAY_URL}/search`, payload);
    logger.info(`Catalog pushed for vendor ${vendor.id}`);
    return result;
  } catch (error) {
    logger.error(`Catalog push failed for vendor ${vendor.id}:`, error.message);
    throw error;
  }
};

module.exports = { pushCatalog };
EOF
log "Catalog service created"

section "Step 12: Create CloudKart Service"
cat > src/services/cloudkart/catalog.service.js << 'EOF'
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
EOF
log "CloudKart catalog service created"

section "Step 13: Create CloudKart Order Service"
cat > src/services/cloudkart/order.service.js << 'EOF'
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
EOF
log "CloudKart order service created"

section "Step 14: Create Vendor Controller"
cat > src/controllers/vendor.controller.js << 'EOF'
const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const logger = require('../utils/logger');

// Get all vendors
const getVendors = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM vendors WHERE status = "active"');
    return success(res, rows, 'Vendors retrieved');
  } catch (err) {
    logger.error('Get vendors failed:', err.message);
    return error(res, 'Failed to get vendors');
  }
};

// Register vendor
const registerVendor = async (req, res) => {
  try {
    const { cloudkart_vendor_id, business_name, gstin, phone, email, address, city } = req.body;
    const [result] = await pool.query(
      'INSERT INTO vendors (cloudkart_vendor_id, business_name, gstin, phone, email, address, city, status) VALUES (?, ?, ?, ?, ?, ?, ?, "active")',
      [cloudkart_vendor_id, business_name, gstin, phone, email, address, city]
    );
    return success(res, { id: result.insertId }, 'Vendor registered', 201);
  } catch (err) {
    logger.error('Register vendor failed:', err.message);
    return error(res, 'Failed to register vendor');
  }
};

// Get vendor by ID
const getVendor = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM vendors WHERE id = ?', [req.params.id]);
    if (!rows.length) return error(res, 'Vendor not found', 404);
    return success(res, rows[0], 'Vendor retrieved');
  } catch (err) {
    logger.error('Get vendor failed:', err.message);
    return error(res, 'Failed to get vendor');
  }
};

module.exports = { getVendors, registerVendor, getVendor };
EOF
log "Vendor controller created"

section "Step 15: Create ONDC Controller"
cat > src/controllers/ondc.controller.js << 'EOF'
const { ack, nack } = require('../utils/response');
const { createOrder } = require('../services/cloudkart/order.service');
const logger = require('../utils/logger');

// Handle on_search from ONDC
const onSearch = async (req, res) => {
  try {
    logger.info('on_search received', { body: req.body });
    return ack(res);
  } catch (err) {
    logger.error('on_search failed:', err.message);
    return nack(res, err.message);
  }
};

// Handle on_init from ONDC
const onInit = async (req, res) => {
  try {
    logger.info('on_init received', { body: req.body });
    return ack(res);
  } catch (err) {
    logger.error('on_init failed:', err.message);
    return nack(res, err.message);
  }
};

// Handle on_confirm - order placed
const onConfirm = async (req, res) => {
  try {
    logger.info('on_confirm received', { body: req.body });
    const order = req.body?.message?.order;
    if (order) {
      await createOrder(order);
    }
    return ack(res);
  } catch (err) {
    logger.error('on_confirm failed:', err.message);
    return nack(res, err.message);
  }
};

// Handle on_status
const onStatus = async (req, res) => {
  try {
    logger.info('on_status received', { body: req.body });
    return ack(res);
  } catch (err) {
    logger.error('on_status failed:', err.message);
    return nack(res, err.message);
  }
};

// Handle on_cancel
const onCancel = async (req, res) => {
  try {
    logger.info('on_cancel received', { body: req.body });
    return ack(res);
  } catch (err) {
    logger.error('on_cancel failed:', err.message);
    return nack(res, err.message);
  }
};

// Handle on_update
const onUpdate = async (req, res) => {
  try {
    logger.info('on_update received', { body: req.body });
    return ack(res);
  } catch (err) {
    logger.error('on_update failed:', err.message);
    return nack(res, err.message);
  }
};

module.exports = { onSearch, onInit, onConfirm, onStatus, onCancel, onUpdate };
EOF
log "ONDC controller created"

section "Step 16: Create Routes"
cat > src/routes/vendor.routes.js << 'EOF'
const express = require('express');
const router = express.Router();
const { getVendors, registerVendor, getVendor } = require('../controllers/vendor.controller');

router.get('/', getVendors);
router.post('/register', registerVendor);
router.get('/:id', getVendor);

module.exports = router;
EOF

cat > src/routes/ondc.routes.js << 'EOF'
const express = require('express');
const router = express.Router();
const { onSearch, onInit, onConfirm, onStatus, onCancel, onUpdate } = require('../controllers/ondc.controller');

router.post('/on_search', onSearch);
router.post('/on_init', onInit);
router.post('/on_confirm', onConfirm);
router.post('/on_status', onStatus);
router.post('/on_cancel', onCancel);
router.post('/on_update', onUpdate);

module.exports = router;
EOF
log "Routes created"

section "Step 17: Create Database Tables"
cat > src/config/migrate.js << 'EOF'
require('dotenv').config();
const mysql = require('mysql2/promise');

const migrate = async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS vendors (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cloudkart_vendor_id VARCHAR(100) UNIQUE,
      business_name VARCHAR(255) NOT NULL,
      gstin VARCHAR(20),
      phone VARCHAR(20),
      email VARCHAR(255),
      address TEXT,
      city VARCHAR(100),
      gps VARCHAR(50),
      status ENUM('pending','active','suspended') DEFAULT 'active',
      ondc_registered_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS ondc_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ondc_order_id VARCHAR(255) UNIQUE,
      cloudkart_order_id VARCHAR(255),
      vendor_id INT,
      status VARCHAR(50) DEFAULT 'pending',
      total_amount DECIMAL(10,2),
      buyer_info JSON,
      items JSON,
      fulfillment JSON,
      payment JSON,
      raw_payload JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS sync_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      vendor_id INT,
      sync_type ENUM('catalog','inventory','order'),
      status ENUM('success','failed','pending'),
      items_synced INT DEFAULT 0,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('✓ Database tables created successfully');
  await conn.end();
};

migrate().catch(console.error);
EOF
log "Migration file created"

section "Step 18: Create PM2 Config"
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'ondc-connector',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: { NODE_ENV: 'production', PORT: 4000 },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true
  }]
}
EOF
log "PM2 config created"

section "Step 19: Create Main server.js"
cat > server.js << 'EOF'
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const logger = require('./src/utils/logger');
const { connectDB } = require('./src/config/database');

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ONDC Connector',
    subscriber_id: process.env.ONDC_SUBSCRIBER_ID,
    env: process.env.ONDC_ENV,
    timestamp: new Date().toISOString()
  });
});

// ONDC subscribe endpoint
app.get('/on_subscribe', (req, res) => {
  res.json({ status: 'ok', subscriber_id: process.env.ONDC_SUBSCRIBER_ID });
});

// Routes
app.use('/api/vendor', require('./src/routes/vendor.routes'));
app.use('/ondc', require('./src/routes/ondc.routes'));

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const start = async () => {
  await connectDB();
  app.listen(PORT, () => {
    logger.info(`ONDC Connector running on port ${PORT}`);
    logger.info(`Subscriber ID: ${process.env.ONDC_SUBSCRIBER_ID}`);
    logger.info(`Environment: ${process.env.ONDC_ENV}`);
  });
};

start();
module.exports = app;
EOF
log "server.js created"

section "Step 20: Run Database Migration"
node src/config/migrate.js
log "Database migrated"

section "Step 21: Restart PM2"
pm2 stop ondc-connector 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

section "Step 22: Test Endpoints"
sleep 3
echo "Testing health endpoint..."
curl -s http://localhost:4000/health | python3 -m json.tool
echo ""
echo "Testing on_subscribe endpoint..."
curl -s http://localhost:4000/on_subscribe | python3 -m json.tool

section "✅ ONDC Connector Setup Complete!"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN} Endpoints Available${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${YELLOW}Health:${NC}       https://ondc.cottkart.com/health"
echo -e "  ${YELLOW}Subscribe:${NC}    https://ondc.cottkart.com/on_subscribe"
echo -e "  ${YELLOW}Vendors:${NC}      https://ondc.cottkart.com/api/vendor"
echo -e "  ${YELLOW}on_search:${NC}    https://ondc.cottkart.com/ondc/on_search"
echo -e "  ${YELLOW}on_confirm:${NC}   https://ondc.cottkart.com/ondc/on_confirm"
echo -e "  ${YELLOW}on_status:${NC}    https://ondc.cottkart.com/ondc/on_status"
echo -e "  ${YELLOW}on_cancel:${NC}    https://ondc.cottkart.com/ondc/on_cancel"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  PM2 Status:${NC}"
pm2 status
echo ""
