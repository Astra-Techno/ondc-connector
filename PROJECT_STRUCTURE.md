# ONDC Connector — Project Structure

> Vue 3 + Tailwind CSS dashboard (frontend) + Node.js/Express middleware (backend)
> Connects CottKart (multi-vendor e-commerce) to ONDC network

## Directory Tree

```
ondc-connector/
├── server.js                        # Express server entry (500 lines)
├── package.json                     # Backend dependencies
├── .env                             # Environment config
├── nginx.conf                       # Nginx reverse proxy
├── ecosystem.config.js              # PM2 config
├── deploy.sh                        # Deployment script
│
├── dashboard/                       # Vue 3 Frontend (Vite)
│   ├── vite.config.js               # Vite + proxy config
│   ├── .env.development             # VITE_API_URL (must be empty for proxy)
│   ├── .env.production
│   └── src/
│       ├── main.js                  # App entry
│       ├── App.vue                  # Root component
│       ├── router/index.js          # Vue Router (18 routes)
│       ├── stores/
│       │   ├── auth.js              # Pinia: API key + tenant state
│       │   └── toast.js             # Toast notifications
│       ├── utils/api.js             # Axios instance + interceptors
│       ├── components/
│       │   ├── AppLayout.vue        # Sidebar + main layout
│       │   └── ToastNotification.vue
│       └── views/
│           ├── Login.vue            # Glassy login page
│           ├── Dashboard.vue        # Stats cards
│           ├── Vendors.vue          # Vendor list
│           ├── VendorDetail.vue     # Vendor detail/edit
│           ├── Products.vue         # Product catalog
│           ├── Orders.vue           # Order list
│           ├── OrderDetail.vue      # Order detail
│           ├── Settlements.vue      # Payouts
│           ├── IGM.vue              # Issues & Grievances
│           ├── IGMDemo.vue          # IGM Workflow Logs (live timeline)
│           ├── Transactions.vue     # ONDC transaction log
│           ├── SyncLogs.vue         # Job logs
│           ├── Webhooks.vue         # Webhook config
│           ├── Settings.vue         # App settings
│           └── Admin.vue            # Admin panel
│
├── src/                             # Backend
│   ├── config/
│   │   ├── database.js              # MySQL pool (mysql2/promise)
│   │   └── redis.js                 # Redis client
│   │
│   ├── controllers/
│   │   ├── ondc.controller.js       # ALL ONDC flows (3900+ lines)
│   │   ├── order.controller.js      # Order persistence
│   │   ├── catalog.controller.js    # Catalog sync
│   │   ├── vendor.controller.js     # Vendor CRUD
│   │   ├── tenant.controller.js     # Multi-tenant setup
│   │   ├── dashboard.controller.js  # Stats, transactions, IGM flows
│   │   ├── settlement.controller.js # Payout processing
│   │   ├── igm.controller.js        # IGM CRUD
│   │   ├── logistics.controller.js  # LSP relay (14KB)
│   │   └── webhook.controller.js    # Webhook dispatch
│   │
│   ├── routes/
│   │   ├── tenant.routes.js         # POST /register, GET /info
│   │   ├── vendor.routes.js         # Vendor sync/CRUD
│   │   ├── catalog.routes.js        # Catalog + inventory sync
│   │   ├── order.routes.js          # Order retrieval
│   │   ├── dashboard.routes.js      # Stats + transactions + IGM flows
│   │   ├── settlement.routes.js     # Settlement history
│   │   ├── igm.routes.js            # Issues endpoints
│   │   └── webhook.routes.js        # Webhook management
│   │
│   ├── services/
│   │   ├── ondc/
│   │   │   ├── order.service.js     # buildQuote, sendCallback, getTenantByBppId
│   │   │   ├── logPublisher.service.js  # Network Observability push
│   │   │   ├── igm2Workflow.js      # IGM 2.0 state machine
│   │   │   ├── igmOrderUpdate.js    # IGM refund logic
│   │   │   └── workflowPolicy.js    # Flow classification
│   │   ├── cloudkart/
│   │   │   ├── vendor.service.js    # Fetch vendors from CottKart
│   │   │   ├── catalog.service.js   # Fetch products/inventory
│   │   │   └── order.service.js     # Push/fetch orders
│   │   ├── settlement.service.js    # Cashfree payouts
│   │   └── logistics/
│   │       └── lsp.service.js       # LSP integration (stub)
│   │
│   ├── jobs/
│   │   ├── index.js                 # startAllJobs()
│   │   ├── catalogSync.job.js       # Every 30 min
│   │   ├── inventorySync.job.js     # Every 15 min
│   │   └── orderSync.job.js         # Every 5 min
│   │
│   ├── middleware/
│   │   └── tenant.js                # X-API-Key auth + tenant resolution
│   │
│   └── utils/
│       ├── logger.js                # Winston daily-rotate
│       ├── crypto.js                # Ed25519 signing, BLAKE-512
│       ├── ondcErrors.js            # ONDC error codes
│       └── response.js             # ACK/NACK builders
│
├── database/
│   └── migration.sql                # Full schema (12 tables)
│
└── logs/                            # Daily rotated logs
```

## Architecture Overview

```
   ONDC Gateway / BAP
         │
    ┌────▼────┐
    │ server.js│ ← Port 4000
    │ Express  │
    └────┬────┘
         │
    ┌────▼──────────────┐
    │ ondc.controller.js │ ← All ONDC action handlers
    │ (3900+ lines)      │
    └────┬──────────────┘
         │
    ┌────▼────────────────┐
    │ services/            │
    │ ├─ ondc/             │ ← Quote, callbacks, IGM state machine
    │ ├─ cloudkart/        │ ← CottKart API integration
    │ └─ logistics/        │ ← LSP relay (future)
    └────┬────────────────┘
         │
    ┌────▼────┐    ┌──────────┐
    │  MySQL  │    │  Redis   │
    │ 12 tables│    │ (cache)  │
    └─────────┘    └──────────┘

    Dashboard (Vue 3) ← Port 3000
         │
    ┌────▼──────────┐
    │ /api/v1/*      │ ← Vite proxy → localhost:4000
    │ X-API-Key auth │
    └───────────────┘
```

## Key Patterns

| Pattern | Detail |
|---------|--------|
| **API envelope** | `{ success, message, data: {...} }` — frontend unwraps `.data.data` |
| **Auth** | API key in localStorage → `X-API-Key` header → `resolveTenant` middleware |
| **ONDC routes** | Root-level (`/search`, `/confirm`) — no `/api` prefix |
| **Dashboard routes** | `/api/v1/dashboard/*` — protected by tenant middleware |
| **In-memory caches** | `confirmedOrderCache`, `issueCache`, `cancelledOrders` in ondc.controller.js |
| **Background jobs** | node-cron: catalog (30m), inventory (15m), orders (5m), settlements (daily) |
| **Logging** | Winston daily-rotate + workbench.log for ONDC exchanges |

## Ports

| Service | Port | Notes |
|---------|------|-------|
| Backend (Express) | 4000 | ONDC callbacks + API |
| Frontend (Vite dev) | 3000 | Proxy `/api` → 4000 |
| Production | 80/443 | Nginx → PM2 (4000) |
| MySQL | 3306 | |
| Redis | 6379 | Optional |
