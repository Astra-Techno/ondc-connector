<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { get } from '@/utils/api'
import {
  Store, Package, ShoppingCart, TrendingUp,
  RefreshCw, AlertCircle, CheckCircle, Clock,
  CreditCard, MessageSquare,
} from 'lucide-vue-next'

const router  = useRouter()
const loading = ref(true)
const error   = ref(null)
const stats   = ref(null)

const statusColors = {
  confirmed:  'bg-blue-100 text-blue-700',
  packed:     'bg-yellow-100 text-yellow-700',
  shipped:    'bg-orange-100 text-orange-700',
  delivered:  'bg-green-100 text-green-700',
  cancelled:  'bg-red-100 text-red-700',
}

async function fetchStats() {
  loading.value = true
  error.value   = null
  const { data, error: err } = await get('/dashboard/stats')
  if (err) { error.value = err }
  else { stats.value = data }
  loading.value = false
}

function formatCurrency(v) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
}
function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

onMounted(fetchStats)
</script>

<template>
  <div class="p-6 space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold text-gray-900">Dashboard</h1>
      <button @click="fetchStats" :disabled="loading"
        class="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
        <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" /> Refresh
      </button>
    </div>

    <!-- Error -->
    <div v-if="error" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ error }}
    </div>

    <!-- Stat cards skeleton -->
    <div v-if="loading" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <div v-for="i in 4" :key="i" class="h-28 rounded-xl bg-gray-200 animate-pulse" />
    </div>

    <!-- Stat cards -->
    <div v-else-if="stats" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <div class="flex items-center justify-between">
          <p class="text-sm text-gray-500">Total Vendors</p>
          <div class="rounded-lg bg-green-50 p-2"><Store class="h-5 w-5 text-green-600" /></div>
        </div>
        <p class="mt-3 text-2xl font-bold text-gray-900">{{ stats.vendors?.total ?? '—' }}</p>
        <p class="mt-1 text-xs text-gray-400">{{ stats.vendors?.active ?? 0 }} active</p>
      </div>

      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <div class="flex items-center justify-between">
          <p class="text-sm text-gray-500">Total Products</p>
          <div class="rounded-lg bg-blue-50 p-2"><Package class="h-5 w-5 text-blue-600" /></div>
        </div>
        <p class="mt-3 text-2xl font-bold text-gray-900">{{ stats.products?.total ?? '—' }}</p>
        <p class="mt-1 text-xs text-gray-400">{{ stats.products?.synced ?? 0 }} synced</p>
      </div>

      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <div class="flex items-center justify-between">
          <p class="text-sm text-gray-500">Total Orders</p>
          <div class="rounded-lg bg-orange-50 p-2"><ShoppingCart class="h-5 w-5 text-orange-600" /></div>
        </div>
        <p class="mt-3 text-2xl font-bold text-gray-900">{{ stats.orders?.total ?? '—' }}</p>
        <p class="mt-1 text-xs text-gray-400">{{ stats.orders?.delivered ?? 0 }} delivered</p>
      </div>

      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <div class="flex items-center justify-between">
          <p class="text-sm text-gray-500">Total Revenue</p>
          <div class="rounded-lg bg-purple-50 p-2"><TrendingUp class="h-5 w-5 text-purple-600" /></div>
        </div>
        <p class="mt-3 text-2xl font-bold text-gray-900">{{ formatCurrency(stats.orders?.revenue) }}</p>
        <p class="mt-1 text-xs text-gray-400">{{ stats.orders?.cancelled ?? 0 }} cancelled</p>
      </div>
    </div>

    <!-- Row 2: ONDC + Recent Orders -->
    <div v-if="!loading && stats" class="grid gap-4 lg:grid-cols-3">
      <!-- ONDC Connection -->
      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <h2 class="mb-4 font-semibold text-gray-800">ONDC Connection</h2>
        <div class="space-y-3 text-sm">
          <div class="flex justify-between">
            <span class="text-gray-500">Subscriber ID</span>
            <span class="font-mono text-xs text-gray-700 max-w-[180px] truncate">{{ stats.ondc?.subscriber_id || '—' }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-500">Environment</span>
            <span class="rounded-full px-2 py-0.5 text-xs font-medium"
              :class="stats.ondc?.environment === 'prod' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'">
              {{ stats.ondc?.environment || 'preprod' }}
            </span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-500">Key Expiry</span>
            <span class="text-gray-700">{{ formatDate(stats.ondc?.key_expiry) }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-500">Status</span>
            <span class="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
              :class="stats.ondc?.connected ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'">
              <CheckCircle v-if="stats.ondc?.connected" class="h-3 w-3" />
              <Clock v-else class="h-3 w-3" />
              {{ stats.ondc?.connected ? 'Connected' : 'Not configured' }}
            </span>
          </div>
        </div>
      </div>

      <!-- Recent Orders -->
      <div class="lg:col-span-2 rounded-xl bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
        <div class="border-b border-gray-100 px-5 py-4">
          <h2 class="font-semibold text-gray-800">Recent Orders</h2>
        </div>
        <div v-if="stats.recent_orders?.length">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th class="px-5 py-3 text-left font-medium">Order ID</th>
                <th class="px-5 py-3 text-left font-medium">Amount</th>
                <th class="px-5 py-3 text-left font-medium">Status</th>
                <th class="px-5 py-3 text-left font-medium">Date</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              <tr v-for="order in stats.recent_orders" :key="order.id"
                class="cursor-pointer hover:bg-gray-50/50"
                @click="router.push(`/orders/${order.id}`)">
                <td class="px-5 py-3 font-mono text-xs text-gray-600">{{ order.ondc_order_id || order.id }}</td>
                <td class="px-5 py-3 font-medium text-gray-900">{{ formatCurrency(order.amount) }}</td>
                <td class="px-5 py-3">
                  <span :class="['rounded-full px-2 py-0.5 text-xs font-medium capitalize', statusColors[order.status] || 'bg-gray-100 text-gray-600']">
                    {{ order.status }}
                  </span>
                </td>
                <td class="px-5 py-3 text-gray-500">{{ formatDate(order.created_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="px-5 py-10 text-center text-sm text-gray-400">No recent orders</div>
      </div>
    </div>

    <!-- Row 3: Settlement summary + IGM summary -->
    <div v-if="!loading && stats" class="grid gap-4 lg:grid-cols-2">
      <!-- Settlement summary -->
      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100 cursor-pointer hover:shadow-md transition-shadow"
        @click="router.push('/settlements')">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="font-semibold text-gray-800">Settlements</h2>
          <div class="rounded-lg bg-green-50 p-2"><CreditCard class="h-5 w-5 text-green-600" /></div>
        </div>
        <div class="grid grid-cols-3 gap-4 text-center">
          <div>
            <p class="text-xs text-gray-500 mb-1">Pending</p>
            <p class="text-lg font-bold text-yellow-600">{{ formatCurrency(stats.settlement?.pending) }}</p>
          </div>
          <div>
            <p class="text-xs text-gray-500 mb-1">Processed</p>
            <p class="text-lg font-bold text-green-600">{{ formatCurrency(stats.settlement?.processed) }}</p>
          </div>
          <div>
            <p class="text-xs text-gray-500 mb-1">This Month</p>
            <p class="text-lg font-bold text-blue-600">{{ formatCurrency(stats.settlement?.this_month) }}</p>
          </div>
        </div>
      </div>

      <!-- IGM summary -->
      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100 cursor-pointer hover:shadow-md transition-shadow"
        @click="router.push('/igm')">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="font-semibold text-gray-800">Issues & Grievances</h2>
          <div class="rounded-lg bg-red-50 p-2"><MessageSquare class="h-5 w-5 text-red-500" /></div>
        </div>
        <div class="grid grid-cols-3 gap-4 text-center">
          <div>
            <p class="text-xs text-gray-500 mb-1">Open</p>
            <p class="text-2xl font-bold text-red-600">{{ stats.igm?.open ?? 0 }}</p>
          </div>
          <div>
            <p class="text-xs text-gray-500 mb-1">In Progress</p>
            <p class="text-2xl font-bold text-yellow-600">{{ stats.igm?.in_progress ?? 0 }}</p>
          </div>
          <div>
            <p class="text-xs text-gray-500 mb-1">Resolved</p>
            <p class="text-2xl font-bold text-green-600">{{ stats.igm?.resolved ?? 0 }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Last sync -->
    <div v-if="stats?.last_sync" class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100 flex items-center gap-3 text-sm text-gray-500">
      <RefreshCw class="h-4 w-4 text-green-500" />
      Last sync: <span class="font-medium text-gray-700">{{ formatDate(stats.last_sync) }}</span>
    </div>
  </div>
</template>
