# ONDC Connector — Complete Development Guide
## For VSCode Claude Plugin

---

## PROJECT CONTEXT

You are building an **ONDC Connector** — a middleware SaaS that connects
CottKart (a multi-vendor e-commerce platform) to the ONDC (Open Network
for Digital Commerce) network in India.

### Tech Stack
- **Backend:** Node.js + Express (root folder)
- **Frontend:** Vue 3 + Tailwind CSS (dashboard/ folder)
- **Database:** MySQL (ondc_connector_db)
- **Queue:** Bull + Redis
- **Process Manager:** PM2
- **Hosting:** MilesWeb VPS (Ubuntu 24.04)

### Key URLs
- Backend API: http://localhost:4000
- Dashboard: http://localhost:3000
- ONDC Subscriber ID: ondc.cottkart.com
- ONDC Environment: preprod
- CottKart URL: https://cottkart.com

### Database Config (Local)
- Host: 127.0.0.1
- DB: ondc_connector
- User: root
- Password: (empty)

---

## CURRENT PROJECT STRUCTURE

```
ondc-connector/
├── server.js                          ✅ Done
├── ecosystem.config.js                ✅ Done
├── .env                               ✅ Done
├── src/
│   ├── config/
│   │   ├── database.js                ✅ Done
│   │   └── redis.js                   ✅ Done
│   ├── controllers/
│   │   ├── ondc.controller.js         ✅ Done (search only)
│   │   ├── catalog.controller.js      ✅ Done
│   │   ├── vendor.controller.js       ✅ Done
│   │   ├── order.controller.js        ⚠️ Partial
│   │   ├── tenant.controller.js       ✅ Done
│   │   ├── dashboard.controller.js    ✅ Done
│   │   └── webhook.controller.js      ✅ Done
│   ├── middleware/
│   │   └── tenant.js                  ✅ Done
│   ├── models/                        ❌ Empty
│   ├── routes/
│   │   ├── vendor.routes.js           ✅ Done
│   │   ├── catalog.routes.js          ✅ Done
│   │   ├── order.routes.js            ✅ Done
│   │   ├── ondc.routes.js             ✅ Done
│   │   ├── webhook.routes.js          ✅ Done
│   │   └── dashboard.routes.js        ✅ Done
│   ├── services/
│   │   ├── ondc/
│   │   │   ├── auth.service.js        ✅ Done
│   │   │   ├── catalog.service.js     ✅ Done
│   │   │   └── order.service.js       ❌ Missing
│   │   └── cloudkart/
│   │       ├── vendor.service.js      ❌ Missing
│   │       ├── catalog.service.js     ✅ Done
│   │       └── order.service.js       ⚠️ Partial
│   ├── queue/
│   │   ├── catalog.queue.js           ❌ Missing
│   │   ├── order.queue.js             ❌ Missing
│   │   └── index.js                   ❌ Missing
│   ├── jobs/
│   │   ├── catalogSync.job.js         ❌ Missing
│   │   ├── inventorySync.job.js       ❌ Missing
│   │   └── orderSync.job.js           ❌ Missing
│   └── utils/
│       ├── logger.js                  ✅ Done
│       ├── crypto.js                  ✅ Done
│       ├── response.js                ✅ Done
│       ├── ondcMapper.js              ✅ Done
│       └── validator.js               ✅ Done
└── dashboard/
    └── src/
        ├── views/                     ✅ All views done
        ├── stores/                    ✅ Done
        ├── router/                    ✅ Done
        └── components/                ✅ Done
```

---

## WHAT NEEDS TO BE BUILT

### Priority 1 — ONDC Complete Order Flow

#### 1.1 Update src/controllers/ondc.controller.js

Add these handlers (currently only search is done):

**handleSelect** — buyer selects items, return quote
```
ONDC sends /select with selected items
You respond with ACK
Then callback POST to bap_uri/on_select with:
- Quote (item prices + delivery charges)
- Fulfillment details
- Payment terms
```

**handleInit** — buyer initiates order, return order object
```
ONDC sends /init with billing + fulfillment details
You respond with ACK
Then callback POST to bap_uri/on_init with:
- Full order object
- Quote breakdown
- Payment details
- Terms & conditions
```

**handleConfirm** — buyer confirms order
```
ONDC sends /confirm with payment info
You respond with ACK
Then:
1. Save order to ondc_orders table
2. POST order to CottKart API
3. Callback POST to bap_uri/on_confirm with confirmed order
```

**handleStatus** — buyer checks order status
```
ONDC sends /status with order_id
You respond with ACK
Then:
1. Fetch order status from CottKart
2. Callback POST to bap_uri/on_status with fulfillment status
```

**handleCancel** — buyer cancels order
```
ONDC sends /cancel with order_id + reason
You respond with ACK
Then:
1. Cancel order in CottKart
2. Update ondc_orders table
3. Callback POST to bap_uri/on_cancel with cancellation confirmation
```

**handleTrack** — buyer tracks shipment
```
ONDC sends /track with order_id
You respond with ACK
Then:
1. Fetch tracking from CottKart
2. Callback POST to bap_uri/on_track with tracking URL/info
```

**handleSupport** — buyer requests support contact
```
ONDC sends /support with order_id
You respond with ACK
Then callback POST to bap_uri/on_support with:
- Phone number
- Email
- Chat URL
```

**handleRating** — buyer rates order
```
ONDC sends /rating with order_id + rating
You respond with ACK
Save rating to DB
Callback POST to bap_uri/on_rating with ACK
```

**handleIssue** — IGM complaint
```
ONDC sends /issue with complaint details
You respond with ACK
Save to issue_grievances table
Callback POST to bap_uri/on_issue with issue ID + status
```

**handleIssueStatus** — IGM status check
```
ONDC sends /issue_status with issue_id
You respond with ACK
Callback POST to bap_uri/on_issue_status with current status
```

---

#### 1.2 Create src/services/ondc/order.service.js

```
Functions needed:

buildQuote(items, vendor, fulfillment)
- Calculate item totals
- Add delivery charges
- Return ONDC quote format

buildOrderObject(context, message, status)
- Build complete ONDC order object
- Include all required ONDC fields
- Return properly formatted order

sendCallback(bapUri, action, context, message)
- POST to bap_uri/on_{action}
- Add proper Authorization header (ed25519 signing)
- Handle timeout and retry
- Log all callbacks

cancelOrder(ondcOrderId, reason)
- Update DB status
- Return cancellation confirmation

updateOrderStatus(ondcOrderId, status, fulfillmentDetails)
- Update DB
- Build status response
```

---

#### 1.3 Update server.js routes

Add these root-level ONDC routes:
```
POST /select    → handleSelect
POST /init      → handleInit  
POST /confirm   → handleConfirm
POST /status    → handleStatus
POST /cancel    → handleCancel
POST /track     → handleTrack
POST /support   → handleSupport
POST /rating    → handleRating
POST /issue     → handleIssue
POST /issue_status → handleIssueStatus
```

---

### Priority 2 — CottKart Integration Service

#### 2.1 Create src/services/cloudkart/vendor.service.js

```
CottKart API base: https://cottkart.com
Auth: X-API-Key header

Functions needed:

fetchVendors(page, limit)
- GET https://cottkart.com/api/vendors?page=X&limit=X
- Return vendor list in standard format

fetchVendorById(vendorId)  
- GET https://cottkart.com/api/vendors/:id
- Return single vendor

Standard vendor format to return:
{
  vendor_id: string,
  business_name: string,
  gstin: string,
  phone: string,
  email: string,
  address: string,
  city: string,
  state: string,
  pincode: string,
  gps: string (lat,long),
  logo_url: string,
  ondc_eligible: boolean
}
```

#### 2.2 Update src/services/cloudkart/catalog.service.js

```
Functions needed:

fetchProducts(vendorId, page, limit)
- GET https://cottkart.com/api/products?vendor_id=X&page=X&limit=X
- Return products in standard format

fetchInventory(vendorId)
- GET https://cottkart.com/api/inventory?vendor_id=X
- Return stock levels

Standard product format to return:
{
  product_id: string,
  vendor_id: string,
  name: string,
  description: string,
  category: string,
  hsn_code: string,
  price: number,
  mrp: number,
  stock: number,
  unit: string,
  images: string[],
  is_returnable: boolean,
  is_cancellable: boolean,
  time_to_ship: string,
  available_on_cod: boolean,
  is_active: boolean
}
```

#### 2.3 Update src/services/cloudkart/order.service.js

```
Functions needed:

pushOrder(ondcOrder)
- POST https://cottkart.com/api/ondc/orders
- Send ONDC order in CottKart format
- Return CottKart order ID

fetchOrderStatus(cottKartOrderId)
- GET https://cottkart.com/api/orders/:id
- Return status + tracking info

cancelOrder(cottKartOrderId, reason)
- PUT https://cottkart.com/api/orders/:id/status
- Body: { status: 'cancelled', reason: reason }

fetchTrackingInfo(cottKartOrderId)
- GET https://cottkart.com/api/orders/:id/tracking
- Return tracking URL and details

Standard CottKart order format to send:
{
  ondc_order_id: string,
  ondc_transaction_id: string,
  buyer_name: string,
  buyer_phone: string,
  buyer_email: string,
  delivery_address: object,
  items: [{
    product_id: string,
    quantity: number,
    price: number
  }],
  payment_type: string,
  total_amount: number
}
```

---

### Priority 3 — Scheduler Jobs

#### 3.1 Create src/jobs/catalogSync.job.js

```
Schedule: every 30 minutes using node-cron

Steps:
1. Fetch all active vendors from ondc_connector_db
2. For each vendor:
   a. Call fetchProducts from cloudkart catalog service
   b. Upsert products into products table
   c. Update ondc_sync_status
   d. Log sync result to sync_logs
3. Handle errors gracefully (don't stop on single vendor failure)
4. Send alert if sync fails 3 times consecutively
```

#### 3.2 Create src/jobs/inventorySync.job.js

```
Schedule: every 15 minutes using node-cron

Steps:
1. Fetch all active vendors
2. For each vendor call fetchInventory
3. Update stock in products table
4. Log results
```

#### 3.3 Create src/jobs/orderSync.job.js

```
Schedule: every 5 minutes using node-cron

Steps:
1. Fetch all orders with status: confirmed, packed, shipped
2. For each order:
   a. Fetch latest status from CottKart
   b. If status changed, update ondc_orders table
   c. Send on_status callback to BAP
3. Log results
```

#### 3.4 Create src/jobs/index.js

```
Start all schedulers
Export startAllJobs function
Call from server.js on startup
```

---

### Priority 4 — Settlement Module

#### 4.1 Create src/controllers/settlement.controller.js

```
Functions:

getSettlements(req, res)
- GET /api/v1/settlements
- Filter by status, vendor, date range
- Return paginated list

getSettlementById(req, res)
- GET /api/v1/settlements/:id
- Return single settlement with breakdown

processSettlement(req, res)  
- POST /api/v1/settlements/:id/process
- Trigger Cashfree payout
- Update settlement status

getSettlementStats(req, res)
- GET /api/v1/settlements/stats
- Total pending, processed, failed amounts

generateSettlementReport(req, res)
- GET /api/v1/settlements/report?from=X&to=X
- Download CSV report
```

#### 4.2 Create src/services/settlement.service.js

```
Functions:

calculateSettlement(order)
- Calculate from order total:
  - Buyer app finder fee (from ONDC context)
  - Platform commission (configurable %)
  - Seller payout = total - fees
- Save to settlements table
- Return breakdown

processPayoutViaCashfree(settlement)
- Use Cashfree Payout API
- Transfer to seller bank account
- Update settlement with UTR number

generateDailySettlements()
- Run daily at midnight
- Aggregate all delivered orders from previous day
- Create settlement entries
- Queue for payout
```

---

### Priority 5 — IGM (Issue & Grievance Management)

#### 5.1 Create src/controllers/igm.controller.js

```
Functions:

createIssue(req, res) — receives from ONDC /issue
getIssues(req, res) — list all issues
getIssue(req, res) — single issue
updateIssue(req, res) — update status/resolution
```

#### 5.2 Create src/routes/igm.routes.js

```
GET  /api/v1/igm          → getIssues
GET  /api/v1/igm/:id      → getIssue
PUT  /api/v1/igm/:id      → updateIssue
```

---

### Priority 6 — Dashboard Pages to Complete

#### 6.1 Update dashboard/src/views/Orders.vue

Add to existing orders page:
```
- Order detail modal or link to OrderDetail.vue
- Status update dropdown (confirmed/packed/shipped/delivered)
- Show ONDC order ID + CottKart order ID both
- Show buyer details
- Show items ordered
```

#### 6.2 Create dashboard/src/views/Settlements.vue

```
Page: Settlement Reports

Show:
- Stats cards: Total Pending ₹, Total Processed ₹, This Month ₹
- Filter by: status, vendor, date range
- Table: Order ID, Vendor, Amount, Commission, Payout, Status, Date
- Export CSV button
- Settlement detail modal
```

#### 6.3 Create dashboard/src/views/IGM.vue

```
Page: Issue & Grievances

Show:
- Filter by: status (open/in_progress/resolved)
- Table: Issue ID, Order ID, Type, Description, Status, Raised At
- Click to view detail
- Update status + add resolution
```

#### 6.4 Update dashboard/src/views/Dashboard.vue

Add to existing dashboard:
```
- Settlement summary card
- Recent IGM issues
- Sync health indicator (last sync time + status)
- ONDC order flow stats (search count, order count)
```

#### 6.5 Update dashboard/src/components/AppLayout.vue

Add to sidebar:
```
- Settlements (/settlements) - CreditCard icon
- IGM (/igm) - AlertCircle icon
```

---

## ONDC MESSAGE FORMATS

### /select request format
```json
{
  "context": {
    "domain": "ONDC:RET10",
    "action": "select",
    "bap_id": "buyer-app.com",
    "bap_uri": "https://buyer-app.com",
    "bpp_id": "ondc.cottkart.com",
    "bpp_uri": "https://ondc.cottkart.com",
    "transaction_id": "txn-123",
    "message_id": "msg-123",
    "timestamp": "2026-05-18T10:00:00Z"
  },
  "message": {
    "order": {
      "provider": { "id": "V001" },
      "items": [
        { "id": "P001", "quantity": { "count": 2 } }
      ],
      "fulfillments": [
        {
          "id": "f1",
          "type": "Delivery",
          "end": {
            "location": {
              "gps": "13.0827,80.2707",
              "address": {
                "area_code": "600001"
              }
            }
          }
        }
      ]
    }
  }
}
```

### /on_select callback format (you send to BAP)
```json
{
  "context": { "...same as request but action: on_select..." },
  "message": {
    "order": {
      "provider": { "id": "V001" },
      "items": [
        {
          "id": "P001",
          "quantity": { "count": 2 }
        }
      ],
      "quote": {
        "price": { "currency": "INR", "value": "628" },
        "breakup": [
          {
            "title": "Organic Honey x2",
            "@ondc/org/item_id": "P001",
            "price": { "currency": "INR", "value": "598" }
          },
          {
            "title": "Delivery charges",
            "price": { "currency": "INR", "value": "30" }
          }
        ],
        "ttl": "P1D"
      },
      "fulfillments": [
        {
          "id": "f1",
          "type": "Delivery",
          "@ondc/org/TAT": "PT24H",
          "tracking": false
        }
      ]
    }
  }
}
```

### /confirm request format
```json
{
  "context": { "...action: confirm..." },
  "message": {
    "order": {
      "id": "ORDER-123",
      "provider": { "id": "V001" },
      "items": [{ "id": "P001", "quantity": { "count": 2 } }],
      "billing": {
        "name": "John Doe",
        "phone": "+919876543210",
        "email": "john@example.com",
        "address": {
          "street": "123 Main St",
          "city": "Chennai",
          "state": "Tamil Nadu",
          "area_code": "600001"
        }
      },
      "fulfillments": [
        {
          "id": "f1",
          "type": "Delivery",
          "end": {
            "contact": {
              "phone": "+919876543210",
              "email": "john@example.com"
            },
            "location": {
              "gps": "13.0827,80.2707",
              "address": {
                "name": "John Doe",
                "building": "Apt 4B",
                "street": "123 Main St",
                "city": "Chennai",
                "state": "Tamil Nadu",
                "country": "IND",
                "area_code": "600001"
              }
            }
          }
        }
      ],
      "payment": {
        "uri": "https://ondc.org/pay?txn=abc123",
        "tl_method": "http/get",
        "params": {
          "currency": "INR",
          "amount": "628"
        },
        "status": "PAID",
        "type": "ON-ORDER",
        "@ondc/org/buyer_app_finder_fee_type": "percent",
        "@ondc/org/buyer_app_finder_fee_amount": "3"
      },
      "quote": {
        "price": { "currency": "INR", "value": "628" }
      }
    }
  }
}
```

---

## IMPLEMENTATION INSTRUCTIONS FOR CLAUDE

When I ask you to build any of the above, follow these rules:

### Code Style Rules
1. Always use async/await — never callbacks
2. Always wrap DB queries in try/catch
3. Always log errors using logger from src/utils/logger.js
4. Always return proper response using src/utils/response.js
5. Always validate inputs using src/utils/validator.js
6. Use const { pool } = require('../config/database') for DB
7. Use axios for HTTP calls
8. Always handle timeout for external API calls (30 seconds max)

### Response Format Rules
Always use these helpers from src/utils/response.js:
```js
// Success
return success(res, data, 'Message', 200);

// Error  
return error(res, 'Error message', 400, errorsArray);

// ONDC ACK
return ack(res);

// ONDC NACK
return nack(res, 'reason');
```

### ONDC Callback Rules
When sending callbacks to BAP:
1. Always send ACK to original request FIRST
2. Then async send callback to bap_uri
3. Use context from original request
4. Change action to on_{action}
5. Add bpp_id and bpp_uri from ONDC config
6. Generate new message_id (uuid)
7. Keep same transaction_id
8. Log callback attempt + result

### Error Handling Rules
1. Never crash the server on callback failure
2. Log all ONDC transactions to ondc_transactions table
3. Retry failed callbacks up to 3 times
4. After 3 failures log as failed in DB

### Database Rules
Always use these table names:
- tenants
- tenant_ondc_config
- vendors
- products
- categories
- ondc_orders
- ondc_order_items
- sync_logs
- ondc_transactions
- webhooks
- webhook_logs
- api_keys
- issue_grievances
- settlements

---

## HOW TO USE THIS GUIDE IN VSCODE CLAUDE

### For each task, use this prompt format:

```
[Paste this entire guide first OR reference it]

Now build: [specific task name from this guide]

File to create: [file path]

Additional context:
- [any specific requirement]
- [any existing code to integrate with]

Follow all code style rules from the guide.
```

### Example prompt for building handleInit:

```
Using the ONDC Connector project context from my guide:

Build the handleInit function in src/controllers/ondc.controller.js

Requirements:
- Receive /init request from ONDC
- Send immediate ACK response
- Build order quote using buildQuote from order.service.js
- Save partial order to ondc_orders as 'pending'
- Send on_init callback to bap_uri with full order object
- Follow all code style rules
- Use logger, response helpers, DB pool from existing utils
```

---

## BUILD SEQUENCE

Follow this exact order:

### Week 1 — Core ONDC Flow
```
Day 1:
[ ] src/services/ondc/order.service.js
    - buildQuote()
    - buildOrderObject()
    - sendCallback()

Day 2:
[ ] src/controllers/ondc.controller.js (add all handlers)
    - handleSelect
    - handleInit
    - handleConfirm
    - handleStatus
    - handleCancel
    - handleTrack
    - handleSupport
    - handleRating

Day 3:
[ ] src/services/cloudkart/vendor.service.js
[ ] Update src/services/cloudkart/catalog.service.js
[ ] Update src/services/cloudkart/order.service.js

Day 4:
[ ] src/jobs/catalogSync.job.js
[ ] src/jobs/inventorySync.job.js
[ ] src/jobs/orderSync.job.js
[ ] src/jobs/index.js

Day 5:
[ ] Test complete order flow end to end
[ ] Fix any issues
```

### Week 2 — Settlement + IGM
```
Day 1-2:
[ ] src/services/settlement.service.js
[ ] src/controllers/settlement.controller.js
[ ] src/routes/settlement.routes.js

Day 3:
[ ] src/controllers/igm.controller.js
[ ] src/routes/igm.routes.js

Day 4-5:
[ ] dashboard/src/views/Settlements.vue
[ ] dashboard/src/views/IGM.vue
[ ] Update Dashboard.vue
[ ] Update AppLayout.vue sidebar
```

### Week 3 — Testing + Go Live
```
[ ] End to end ONDC flow test
[ ] ONDC portal Task 1.a complete
[ ] ONDC portal Task 2 verification
[ ] Submit static terms (Task 3)
[ ] Deploy dashboard to VPS
[ ] Go live!
```

---

## DEPLOYMENT COMMANDS

### Build and deploy dashboard to VPS:
```bash
# Local - build dashboard
cd dashboard
npm run build

# Copy dist to VPS (run from local)
scp -r dist/ root@103.212.120.146:/var/www/ondc-connector/dashboard/

# VPS - update Nginx config
# Add to ondc-connector nginx config:
location / {
    root /var/www/ondc-connector/dashboard/dist;
    try_files $uri $uri/ /index.html;
    index index.html;
}

location /api/ {
    proxy_pass http://localhost:4000/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

# Reload nginx
nginx -t && systemctl reload nginx
```

### Deploy backend updates to VPS:
```bash
# Local - push to GitHub
git add .
git commit -m "your message"
git push origin main

# VPS - pull and restart
ssh root@103.212.120.146
cd /var/www/ondc-connector
git pull
npm install --production
pm2 restart ondc-connector
```

---

## IMPORTANT NOTES

1. **ONDC Signing** — All callbacks to BAP must be signed with ed25519 key
   Use src/utils/crypto.js createAuthHeader function

2. **Transaction Logging** — Log every ONDC API call to ondc_transactions table
   Include: action, direction, request, response, status, timing

3. **Idempotency** — ONDC may send same request multiple times
   Use transaction_id + message_id to detect duplicates

4. **Async Callbacks** — Always send ACK first, then process async
   Never make BAP wait for your business logic

5. **Error Recovery** — If callback fails, retry 3 times with backoff
   After 3 failures, mark as failed and alert

6. **CottKart API Key** — Store in .env as CLOUDKART_API_KEY
   Pass as X-API-Key header to all CottKart API calls
