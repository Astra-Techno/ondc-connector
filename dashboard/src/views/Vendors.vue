<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { get } from '@/utils/api'
import { Store, Search, Download, RefreshCw, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-vue-next'

const router = useRouter()
const loading = ref(true)
const error = ref(null)
const vendors = ref([])
const total = ref(0)
const search = ref('')
const statusFilter = ref('')
const page = ref(1)
const perPage = 50
let timer = null

const statusOptions = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'pending', label: 'Pending' },
  { value: 'suspended', label: 'Suspended' },
]

const statusBadge = {
  active:    'bg-green-100 text-green-700',
  pending:   'bg-yellow-100 text-yellow-700',
  suspended: 'bg-red-100 text-red-700',
}

const totalPages = computed(() => Math.ceil(total.value / perPage))

async function fetchVendors() {
  loading.value = true
  error.value = null
  const { data, error: err } = await get('/vendors', {
    status: statusFilter.value || undefined,
    search: search.value || undefined,
    page: page.value,
    per_page: perPage,
  })
  if (err) { error.value = err }
  else {
    vendors.value = data?.vendors || data?.data || []
    total.value = data?.total || vendors.value.length
  }
  loading.value = false
}

function exportCSV() {
  const headers = ['Vendor ID', 'Business Name', 'GSTIN', 'City', 'Phone', 'ONDC Status']
  const rows = vendors.value.map(v => [v.id, v.business_name, v.gstin, v.city, v.phone, v.ondc_status])
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
  const a = document.createElement('a')
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv)
  a.download = 'vendors.csv'
  a.click()
}

function onSearch() { page.value = 1; fetchVendors() }
function onFilter() { page.value = 1; fetchVendors() }

onMounted(() => {
  fetchVendors()
  timer = setInterval(fetchVendors, 30000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="p-6 space-y-5">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-gray-900">Vendors</h1>
        <span class="rounded-full bg-gray-100 px-2.5 py-0.5 text-sm font-medium text-gray-600">{{ total }}</span>
      </div>
      <div class="flex gap-2">
        <button @click="fetchVendors" :disabled="loading" class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
          <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />
        </button>
        <button @click="exportCSV" class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">
          <Download class="h-4 w-4" /> Export
        </button>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-col gap-3 sm:flex-row">
      <div class="relative flex-1">
        <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input v-model="search" @input="onSearch" type="text" placeholder="Search vendors…" class="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/20" />
      </div>
      <select v-model="statusFilter" @change="onFilter" class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500">
        <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
    </div>

    <!-- Error -->
    <div v-if="error" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-sm text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ error }}
    </div>

    <!-- Table -->
    <div class="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-100">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th class="px-5 py-3 text-left font-medium">Vendor ID</th>
              <th class="px-5 py-3 text-left font-medium">Business Name</th>
              <th class="px-5 py-3 text-left font-medium">GSTIN</th>
              <th class="px-5 py-3 text-left font-medium">City</th>
              <th class="px-5 py-3 text-left font-medium">Phone</th>
              <th class="px-5 py-3 text-left font-medium">ONDC Status</th>
              <th class="px-5 py-3 text-left font-medium">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            <!-- Skeleton -->
            <template v-if="loading">
              <tr v-for="i in 8" :key="i">
                <td v-for="j in 7" :key="j" class="px-5 py-3">
                  <div class="h-4 w-24 animate-pulse rounded bg-gray-100" />
                </td>
              </tr>
            </template>

            <!-- Data -->
            <template v-else-if="vendors.length">
              <tr v-for="v in vendors" :key="v.id" class="hover:bg-gray-50/50">
                <td class="px-5 py-3 font-mono text-xs text-gray-500">{{ v.id }}</td>
                <td class="px-5 py-3 font-medium text-gray-900">{{ v.business_name }}</td>
                <td class="px-5 py-3 font-mono text-xs text-gray-600">{{ v.gstin || '—' }}</td>
                <td class="px-5 py-3 text-gray-600">{{ v.city || '—' }}</td>
                <td class="px-5 py-3 text-gray-600">{{ v.phone || '—' }}</td>
                <td class="px-5 py-3">
                  <span :class="['rounded-full px-2 py-0.5 text-xs font-medium capitalize', statusBadge[v.ondc_status] || 'bg-gray-100 text-gray-500']">
                    {{ v.ondc_status || 'unknown' }}
                  </span>
                </td>
                <td class="px-5 py-3">
                  <button @click="router.push(`/vendors/${v.id}`)" class="rounded-lg border border-gray-200 px-3 py-1 text-xs text-gray-600 hover:border-green-400 hover:text-green-600">
                    View
                  </button>
                </td>
              </tr>
            </template>

            <!-- Empty -->
            <tr v-else>
              <td colspan="7" class="px-5 py-16 text-center">
                <Store class="mx-auto mb-3 h-10 w-10 text-gray-200" />
                <p class="text-sm text-gray-400">No vendors found</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="flex items-center justify-between border-t border-gray-100 px-5 py-3 text-sm text-gray-600">
        <span>Page {{ page }} of {{ totalPages }}</span>
        <div class="flex gap-1">
          <button @click="page--; fetchVendors()" :disabled="page === 1" class="rounded p-1 hover:bg-gray-100 disabled:opacity-40">
            <ChevronLeft class="h-4 w-4" />
          </button>
          <button @click="page++; fetchVendors()" :disabled="page === totalPages" class="rounded p-1 hover:bg-gray-100 disabled:opacity-40">
            <ChevronRight class="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
