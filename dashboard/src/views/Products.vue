<script setup>
import { ref, computed, onMounted } from 'vue'
import { get } from '@/utils/api'
import { Package, Search, AlertCircle, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-vue-next'

const loading = ref(true)
const error = ref(null)
const products = ref([])
const total = ref(0)
const search = ref('')
const vendorFilter = ref('')
const syncFilter = ref('')
const page = ref(1)
const perPage = 50
const vendors = ref([])

const syncOptions = [
  { value: '', label: 'All' },
  { value: 'synced', label: 'Synced' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
]

const syncBadge = {
  synced:  'bg-green-100 text-green-700',
  pending: 'bg-yellow-100 text-yellow-700',
  failed:  'bg-red-100 text-red-700',
}

const totalPages = computed(() => Math.ceil(total.value / perPage))

const summary = computed(() => ({
  synced:  products.value.filter(p => p.ondc_sync_status === 'synced').length,
  pending: products.value.filter(p => p.ondc_sync_status === 'pending').length,
  failed:  products.value.filter(p => p.ondc_sync_status === 'failed').length,
}))

async function fetchProducts() {
  loading.value = true
  error.value = null
  const { data, error: err } = await get('/catalog/products', {
    search: search.value || undefined,
    vendor_id: vendorFilter.value || undefined,
    sync_status: syncFilter.value || undefined,
    page: page.value,
    per_page: perPage,
  })
  if (err) { error.value = err }
  else {
    products.value = data?.products || data?.data || []
    total.value = data?.total || products.value.length
  }
  loading.value = false
}

async function fetchVendors() {
  const { data } = await get('/vendors', { per_page: 200 })
  vendors.value = data?.vendors || data?.data || []
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function onSearch() { page.value = 1; fetchProducts() }
function onFilter() { page.value = 1; fetchProducts() }

onMounted(() => { fetchProducts(); fetchVendors() })
</script>

<template>
  <div class="p-6 space-y-5">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-gray-900">Products</h1>
        <span class="rounded-full bg-gray-100 px-2.5 py-0.5 text-sm font-medium text-gray-600">{{ total }}</span>
      </div>
      <button @click="fetchProducts" :disabled="loading" class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
        <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <!-- Sync summary pills -->
    <div v-if="!loading" class="flex gap-3 text-sm">
      <span class="rounded-full bg-green-100 px-3 py-1 font-medium text-green-700">{{ summary.synced }} synced</span>
      <span class="rounded-full bg-yellow-100 px-3 py-1 font-medium text-yellow-700">{{ summary.pending }} pending</span>
      <span class="rounded-full bg-red-100 px-3 py-1 font-medium text-red-700">{{ summary.failed }} failed</span>
    </div>

    <!-- Filters -->
    <div class="flex flex-col gap-3 sm:flex-row">
      <div class="relative flex-1">
        <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input v-model="search" @input="onSearch" placeholder="Search products…" class="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/20" />
      </div>
      <select v-model="vendorFilter" @change="onFilter" class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500">
        <option value="">All Vendors</option>
        <option v-for="v in vendors" :key="v.id" :value="v.id">{{ v.business_name }}</option>
      </select>
      <select v-model="syncFilter" @change="onFilter" class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500">
        <option v-for="opt in syncOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
    </div>

    <div v-if="error" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-sm text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ error }}
    </div>

    <div class="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-100">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th class="px-5 py-3 text-left font-medium">Product ID</th>
              <th class="px-5 py-3 text-left font-medium">Name</th>
              <th class="px-5 py-3 text-left font-medium">Vendor</th>
              <th class="px-5 py-3 text-left font-medium">Price</th>
              <th class="px-5 py-3 text-left font-medium">Stock</th>
              <th class="px-5 py-3 text-left font-medium">Sync Status</th>
              <th class="px-5 py-3 text-left font-medium">Last Synced</th>
              <th class="px-5 py-3 text-left font-medium">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            <template v-if="loading">
              <tr v-for="i in 8" :key="i">
                <td v-for="j in 8" :key="j" class="px-5 py-3">
                  <div class="h-4 w-20 animate-pulse rounded bg-gray-100" />
                </td>
              </tr>
            </template>
            <template v-else-if="products.length">
              <tr v-for="p in products" :key="p.id" class="hover:bg-gray-50/50">
                <td class="px-5 py-3 font-mono text-xs text-gray-500">{{ p.id }}</td>
                <td class="px-5 py-3 font-medium text-gray-900 max-w-[180px] truncate">{{ p.name }}</td>
                <td class="px-5 py-3 text-gray-600">{{ p.vendor_name || '—' }}</td>
                <td class="px-5 py-3 text-gray-700">₹{{ p.price }}</td>
                <td class="px-5 py-3">
                  <span :class="p.stock === 0 ? 'font-semibold text-red-600' : 'text-gray-700'">{{ p.stock ?? '—' }}</span>
                </td>
                <td class="px-5 py-3">
                  <span :class="['rounded-full px-2 py-0.5 text-xs font-medium capitalize', syncBadge[p.ondc_sync_status] || 'bg-gray-100 text-gray-500']">
                    {{ p.ondc_sync_status || 'unknown' }}
                  </span>
                </td>
                <td class="px-5 py-3 text-gray-500">{{ formatDate(p.last_synced_at) }}</td>
                <td class="px-5 py-3">
                  <button class="rounded-lg border border-gray-200 px-3 py-1 text-xs text-gray-600 hover:border-green-400 hover:text-green-600">
                    View
                  </button>
                </td>
              </tr>
            </template>
            <tr v-else>
              <td colspan="8" class="px-5 py-16 text-center">
                <Package class="mx-auto mb-3 h-10 w-10 text-gray-200" />
                <p class="text-sm text-gray-400">No products found</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="totalPages > 1" class="flex items-center justify-between border-t border-gray-100 px-5 py-3 text-sm text-gray-600">
        <span>Page {{ page }} of {{ totalPages }}</span>
        <div class="flex gap-1">
          <button @click="page--; fetchProducts()" :disabled="page === 1" class="rounded p-1 hover:bg-gray-100 disabled:opacity-40"><ChevronLeft class="h-4 w-4" /></button>
          <button @click="page++; fetchProducts()" :disabled="page === totalPages" class="rounded p-1 hover:bg-gray-100 disabled:opacity-40"><ChevronRight class="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  </div>
</template>
