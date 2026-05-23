import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/Login.vue'),
    meta: { public: true, title: 'Login' },
  },
  {
    path: '/',
    redirect: '/dashboard',
  },
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('../views/Dashboard.vue'),
    meta: { requiresAuth: true, title: 'Dashboard' },
  },
  {
    path: '/vendors',
    name: 'Vendors',
    component: () => import('../views/Vendors.vue'),
    meta: { requiresAuth: true, title: 'Vendors' },
  },
  {
    path: '/vendors/:id',
    name: 'VendorDetail',
    component: () => import('../views/VendorDetail.vue'),
    meta: { requiresAuth: true, title: 'Vendor Detail' },
  },
  {
    path: '/products',
    name: 'Products',
    component: () => import('../views/Products.vue'),
    meta: { requiresAuth: true, title: 'Products' },
  },
  {
    path: '/orders',
    name: 'Orders',
    component: () => import('../views/Orders.vue'),
    meta: { requiresAuth: true, title: 'Orders' },
  },
  {
    path: '/orders/:id',
    name: 'OrderDetail',
    component: () => import('../views/OrderDetail.vue'),
    meta: { requiresAuth: true, title: 'Order Detail' },
  },
  {
    path: '/settlements',
    name: 'Settlements',
    component: () => import('../views/Settlements.vue'),
    meta: { requiresAuth: true, title: 'Settlements' },
  },
  {
    path: '/igm',
    name: 'IGM',
    component: () => import('../views/IGM.vue'),
    meta: { requiresAuth: true, title: 'Issues & Grievances' },
  },
  {
    path: '/sync-logs',
    name: 'SyncLogs',
    component: () => import('../views/SyncLogs.vue'),
    meta: { requiresAuth: true, title: 'Sync Logs' },
  },
  {
    path: '/webhooks',
    name: 'Webhooks',
    component: () => import('../views/Webhooks.vue'),
    meta: { requiresAuth: true, title: 'Webhooks' },
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../views/Settings.vue'),
    meta: { requiresAuth: true, title: 'Settings' },
  },
  {
    path: '/admin',
    name: 'Admin',
    component: () => import('../views/Admin.vue'),
    meta: { requiresAuth: true, requiresAdmin: true, title: 'Admin' },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to, from, next) => {
  const apiKey = localStorage.getItem('ondc_api_key')

  // Set page title
  document.title = to.meta.title
    ? `${to.meta.title} — ONDC Connector`
    : 'ONDC Connector'

  if (to.meta.public) {
    if (apiKey && to.name === 'Login') return next({ name: 'Dashboard' })
    return next()
  }

  if (to.meta.requiresAuth && !apiKey) {
    return next({ name: 'Login', query: { redirect: to.fullPath } })
  }

  if (to.meta.requiresAdmin) {
    const isAdmin = localStorage.getItem('ondc_is_admin') === 'true'
    if (!isAdmin) return next({ name: 'Dashboard' })
  }

  next()
})

export default router
