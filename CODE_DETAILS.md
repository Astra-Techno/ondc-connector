# ONDC Connector — Code Details

## 1. Server Entry (server.js)

### Middleware Chain
```
helmet() → cors() → morgan('combined') → express.json(10mb) → rate-limiter(300/60s)
```

### ONDC Middleware (applied to /search, /select, /init, etc.)
1. `ondcLogger` — logs inbound ONDC payload to console
2. `pushInboundTxnLog` — pushes to Network Observability (skip select/init/confirm)
3. `logInboundToDB` — saves to `ondc_transactions` table (all actions)
4. `workbenchLogger` — appends to `logs/workbench.log` for Workbench BAP

### Route Map

#### ONDC Gateway (root-level, no auth)
| Method | Path | Handler |
|--------|------|---------|
| POST | /search | handleSearch |
| POST | /select | handleSelect |
| POST | /init | handleInit |
| POST | /confirm | handleConfirm |
| POST | /status | handleStatus |
| POST | /cancel | handleCancel |
| POST | /track | handleTrack |
| POST | /support | handleSupport |
| POST | /rating | handleRating |
| POST | /update | handleUpdate |
| POST | /issue | handleIssue |
| POST | /issue_status | handleIssueStatus |
| POST | /info | handleInfo |
| POST | /recon | handleRecon |

#### Trigger Endpoints (testing/certification)
| Path | Purpose |
|------|---------|
| POST /trigger/merchant-update/:order_id | Flow 3A partial cancel |
| POST /trigger/merchant-cancel/:order_id | Flow 3B/3C RTO |
| POST /trigger/merchant-return-update/:order_id | Flow 4A/4B return |
| POST /trigger/merchant-status/:order_id | Manual status push |
| POST /trigger/merchant-status-sequence/:order_id | Auto Packed→Shipped→Delivered |
| POST /trigger/set-out-of-stock | Flow 5 OOS injection |
| POST /trigger/clear-out-of-stock | Clear OOS |
| POST /trigger/push-on-search | Force catalog push |

#### Dashboard API (`/api/v1/*`, auth required)
| Mount | Endpoints |
|-------|-----------|
| /api/v1/tenant | POST /register, GET /info |
| /api/v1/vendors | POST /sync, GET /, GET /:id, PUT /:id |
| /api/v1/catalog | POST /sync, POST /inventory, GET /products |
| /api/v1/orders | GET /, GET /:id, PUT /:id/status |
| /api/v1/dashboard | GET /stats, GET /sync-logs, GET /transactions |
| /api/v1/dashboard | GET /igm-flows, GET /igm-flow/:txn_id |
| /api/v1/settlements | GET /, GET /stats, GET /:id, POST /:id/process |
| /api/v1/igm | GET /, GET /:id |
| /api/v1/webhooks | GET /, POST /, DELETE /:id |

---

## 2. ONDC Controller (ondc.controller.js)

The main file — 3900+ lines handling all ONDC protocol flows.

### Key Functions

| Function | Lines | Purpose |
|----------|-------|---------|
| `isCertificationContext(ctx)` | ~60 | Checks if bap_id is workbench.ondc.tech or pramaan.ondc.org |
| `buildFulfillmentWithLocation(f, vendor, state, ts)` | 238-287 | Builds fulfillment with vendor location, TAT, tracking |
| `handleSearch` | ~290-700 | Builds on_search with full catalog per ONDC spec |
| `handleSelect` | ~700-1050 | Builds on_select with quote, fulfillments, Buyer-Delivery support |
| `handleInit` | ~1050-1120 | Builds on_init with payment, billing, fulfillment details |
| `handleConfirm` | ~1120-1250 | Builds on_confirm, caches order, starts status sequence |
| `handleStatus` | ~1250-1500 | Returns on_status with current fulfillment state |
| `handleCancel` | ~1500-1870 | Handles buyer/seller cancel, RTO flow |
| `handleUpdate` | ~1876-2300 | Settlement (3A), Return (4A/4B), Buyer-Delivery status updates |
| `handleTrack` | ~2370-2420 | Returns tracking URL |
| `handleSupport` | ~2420-2480 | Returns support contact info |
| `handleRating` | ~2480-2520 | ACKs rating feedback |
| `handleIssue` | ~3343-3890 | IGM 1.0 + 2.0 issue handling |
| `handleIssueStatus` | ~3896-3980 | Issue status query response |
| `handleRecon` | ~4188-4240 | RSF 2.0 reconciliation |
| `buildStatusPayload` | ~2820-2960 | Builds full on_status response body |
| `triggerMerchantUpdate` | ~2308-2370 | Manual trigger for Flow 3A |
| `triggerMerchantCancel` | ~2500-2700 | Manual trigger for Flow 3B/3C |
| `triggerMerchantReturnUpdate` | ~2700-2820 | Manual trigger for Flow 4A/4B |

### In-Memory Caches
```javascript
confirmedOrderCache  // Map<order_id, { order, context, vendor, confirmTimestamp, ... }>
issueCache           // Map<issue_id, { issue, context, tenant }>
cancelledOrders      // Set<order_id>
forcedOutOfStockItems // Set<item_id>
oosInjectedTxns      // Set<transaction_id>
lastConfirmedOrderId // string — latest order_id for /trigger/*/latest
```

### ONDC Flow Coverage

| Flow | Description | Status |
|------|-------------|--------|
| 1A | Order to confirm (Prepaid) | PASS |
| 1B | Order to confirm (COD) | PASS |
| 2 | Order fulfillment (Packed→Shipped→Delivered) | PASS |
| 3A | Partial cancellation | PASS |
| 3B | Merchant RTO | PASS |
| 3C | Merchant cancel | PASS |
| 4A | Buyer return (approved) | PASS |
| 4B | Buyer return (rejected + approved) | PASS |
| 5 | Out of stock error | PASS |
| 6A-6F | Cancel variations | PASS |
| 7 | Support | PASS |
| 8A | Full catalog search | PASS |
| 8C | Incremental push | PASS |
| 9 | Rating | PASS |
| 10 | Info (BPP details) | PASS |
| 11A/11B | RSF Settlement | PASS |
| A1-A5 | On-Network Logistics | PENDING |

---

## 3. Services

### ondc/order.service.js
```
buildQuote(items, vendor)        → ONDC quote object with breakup
buildOrderObject(order, vendor)  → Full order for DB persistence
sendCallback(bap_uri, action, context, body, tenant) → POST to BAP with retry x3
getTenantByBppId(bpp_id)         → Lookup tenant from DB
updateOrderStatus(order_id, status) → Update DB
```

### ondc/igm2Workflow.js
State machine for IGM 2.0 flows:
```
States: NEW → PROCESSING → AWAITING_INFO → PROPOSING → AWAITING_DECISION → AWAITING_CLOSE → CLOSED
```
- `handle(issue, context, tenant, profile)` — processes incoming /issue
- `status(context, tenant, issue_id)` — processes /issue_status
- Auto-sends deferred callbacks at 2s intervals
- Handles both No-Action and Rejection flows

### ondc/logPublisher.service.js
Network Observability integration:
- Pushes transaction logs to ONDC analytics API
- JWT token management
- Required for Pramaan sync-response validation

### cloudkart/*.service.js
CottKart API integration:
- `fetchVendors()` / `fetchVendorById()` — vendor data
- `fetchProducts()` / `fetchInventory()` — catalog & stock
- `pushOrder()` / `cancelOrder()` — order lifecycle

---

## 4. Database Schema (12 tables)

### Core
| Table | Key Columns |
|-------|-------------|
| **tenants** | id, name, slug, email, status |
| **api_keys** | id, tenant_id, key_value, is_active |
| **tenant_ondc_config** | subscriber_id, signing keys, registry/gateway URLs |

### Business
| Table | Key Columns |
|-------|-------------|
| **vendors** | business_name, gstin, fssai, gps, ondc_provider_id |
| **products** | name, category, price, stock, ondc_sync_status |
| **ondc_orders** | ondc_order_id, status, items (JSON), fulfillment (JSON) |

### Tracking
| Table | Key Columns |
|-------|-------------|
| **sync_logs** | sync_type, status, records_synced, started_at |
| **ondc_transactions** | action, direction, transaction_id, payload |
| **issue_grievances** | issue_id, order_id, status, resolution |
| **settlements** | order_id, seller_payout, status, utr_number |
| **webhooks** | url, event, secret, is_active |
| **webhook_logs** | webhook_id, event, response_code |

---

## 5. Frontend Architecture

### Auth Flow
1. User enters API key on `/login`
2. `auth.js` store saves to `localStorage('ondc_api_key')`
3. `api.js` axios interceptor attaches `X-API-Key` header
4. Backend `resolveTenant` middleware validates → loads tenant
5. 401 response → auto-logout + redirect to `/login`

### API Utility (utils/api.js)
```javascript
// Base: '/api/v1' (dev proxy) or VITE_API_URL (prod)
// Request: attach X-API-Key header
// Response: unwrap { data: { data: ... } } envelope
// 401: logout + redirect

export const get = (url) => api.get(url).then(r => r.data)
export const post = (url, data) => api.post(url, data).then(r => r.data)
```

### Key Views

**Dashboard.vue** — Stat cards: Orders, Revenue, Settlements, IGM Issues. Calls `GET /dashboard/stats`.

**Orders.vue** — Table with status filters. Each row links to OrderDetail.

**IGMDemo.vue** — Live IGM workflow timeline:
- Polls `GET /dashboard/igm-flow/:txn_id` every 3s
- Vertical timeline: left (BAP→BPP), right (BPP→BAP)
- Click to expand full JSON payload
- Color-coded state badges (PROCESSING, RESOLVED, CLOSED, etc.)
- Time deltas between steps

**Transactions.vue** — Full ONDC transaction log with action/direction filters.

---

## 6. Background Jobs

| Job | Schedule | Action |
|-----|----------|--------|
| Catalog Sync | Every 30 min | Fetch products from CottKart → update DB |
| Inventory Sync | Every 15 min | Fetch stock levels → update DB |
| Order Sync | Every 5 min | Poll CottKart for order updates → push on_status |
| Daily Settlement | 00:00 UTC | Calculate & process pending settlements |

All started via `startAllJobs()` in `src/jobs/index.js`, called from `server.js` on boot.

---

## 7. Environment Variables

| Variable | Purpose |
|----------|---------|
| PORT | Server port (default 4000) |
| DB_HOST/USER/PASSWORD/NAME | MySQL connection |
| REDIS_URL | Redis connection |
| COTTKART_API_URL | CottKart backend URL |
| COTTKART_API_KEY | CottKart API key |
| ONDC_SUBSCRIBER_ID | BPP subscriber ID |
| ONDC_SUBSCRIBER_URL | BPP callback URL |
| ONDC_SIGNING_PRIVATE_KEY | Ed25519 private key |
| ONDC_SIGNING_PUBLIC_KEY | Ed25519 public key |
| ONDC_UNIQUE_KEY_ID | Key pair identifier |
| ONDC_ENV | preprod / prod |
| ONDC_REGISTRY_URL | Registry lookup URL |
| ONDC_GATEWAY_URL | Gateway URL |
| ANALYTICS_TOKEN | N.O. analytics bearer token |
| BPP_GST / BPP_PAN | Tax identifiers |
| BPP_BANK_* | Bank details for settlements |
| SETTLEMENT_COMMISSION | Platform commission % |
| CASHFREE_* | Cashfree payout credentials |

---

## 8. Deployment

### Production Server
- Host: `ondc.cottkart.com`
- Path: `/var/www/ondc-connector`
- Process: PM2 (`ondc-connector`)
- Proxy: Nginx (443 → 4000)

### Deploy Command
```bash
cd /var/www/ondc-connector && git pull origin main && pm2 restart ondc-connector
```

### Frontend Build (if dashboard changed)
```bash
cd /var/www/ondc-connector/dashboard && npm install && npx vite build
```
Nginx serves `dashboard/dist/` for the frontend.
