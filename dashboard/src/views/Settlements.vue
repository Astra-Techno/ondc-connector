<script setup>
import { ref, onMounted } from 'vue'
import { get, post } from '@/utils/api'
import { useToast } from '@/stores/toast'
import { Download, RefreshCw, AlertCircle, CreditCard, CheckCircle, Clock, XCircle } from 'lucide-vue-next'

const toast   = useToast()
const loading = ref(true)
const error   = ref(null)
const stats   = ref(null)
const settlements = ref([])
const total   = ref(0)
const page    = ref(1)
const filters = ref({ status: '', vendor_id: '', from: '', to: '' })
const processing = ref(null)

const statusClass = {
  pending:   'bg-yellow-100 text-yellow-700',
  processed: 'bg-green-100 text-green-700',
  failed:    'bg-red-100 text-red-700',
}

async function fetchStats() {
  const { data } = await get('/settlements/stats')
  if (data) stats.value = data
}

async function fetchSettlements() {
  loading.value = true
  error.value   = null
  const params  = { page: page.value, per_page: 50, ...filters.value }
  Object.keys(params).forEach(k => !params[k] && delete params[k])
  const { data, error: err } = await get('/settlements', params)
  if (err) { error.value = err }
  else {
    settlements.value = data.settlements || []
    total.value       = data.total       || 0
  }
  loading.value = false
}

async function processSettlement(id) {
  if (!confirm('Trigger payout for this settlement?')) return
  processing.value = id
  const { data, error: err } = await post(`/settlements/${id}/process`)
  if (err) toast.error(err)
  else { toast.success('Payout initiated'); fetchSettlements() }
  processing.value = null
}

async function downloadReport() {
  const params = new URLSearchParams()
  if (filters.value.from) params.set('from', filters.value.from)
  if (filters.value.to)   params.set('to',   filters.value.to)
  const apiKey = localStorage.getItem('ondc_api_key')
  const url    = `/api/v1/settlements/report?${params.toString()}`
  const link   = document.createElement('a')
  link.href = url
  link.setAttribute('download', 'settlements.csv')

  // Fetch with API key then trigger download
  fetch(url, { headers: { 'X-API-Key': apiKey } })
    .then(r => r.blob())
    .then(blob => {
      const objUrl = URL.createObjectURL(blob)
      link.href = objUrl
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(objUrl)
    })
}

function formatCurrency(v) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
}
function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function applyFilters() { page.value = 1; fetchSettlements() }

onMounted(async () => {
  await Promise.all([fetchStats(), fetchSettlements()])
})
</script>

<template>
  <div class="p-6 space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold text-gray-900">Settlements</h1>
      <div class="flex gap-2">
        <button @click="downloadReport" class="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">
          <Download class="h-4 w-4" /> Export CSV
        </button>
        <button @click="fetchSettlements" :disabled="loading" class="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
          <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" /> Refresh
        </button>
      </div>
    </div>

    <!-- Stats cards -->
    <div v-if="stats" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <div class="flex items-center gap-2 text-yellow-600 mb-2"><Clock class="h-4 w-4" /><p class="text-sm text-gray-500">Pending Payout</p></div>
        <p class="text-2xl font-bold text-gray-900">{{ formatCurrency(stats.pending_amount) }}</p>
      </div>
      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <div class="flex items-center gap-2 text-green-600 mb-2"><CheckCircle class="h-4 w-4" /><p class="text-sm text-gray-500">Processed</p></div>
        <p class="text-2xl font-bold text-gray-900">{{ formatCurrency(stats.processed_amount) }}</p>
      </div>
      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <div class="flex items-center gap-2 text-red-500 mb-2"><XCircle class="h-4 w-4" /><p class="text-sm text-gray-500">Failed</p></div>
        <p class="text-2xl font-bold text-gray-900">{{ formatCurrency(stats.failed_amount) }}</p>
      </div>
      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <div class="flex items-center gap-2 text-blue-600 mb-2"><CreditCard class="h-4 w-4" /><p class="text-sm text-gray-500">This Month</p></div>
        <p class="text-2xl font-bold text-gray-900">{{ formatCurrency(stats.this_month) }}</p>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100">
      <select v-model="filters.status" class="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500">
        <option value="">All Status</option>
        <option value="pending">Pending</option>
        <option value="processed">Processed</option>
        <option value="failed">Failed</option>
      </select>
      <input v-model="filters.from" type="date" class="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500" />
      <input v-model="filters.to" type="date" class="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500" />
      <button @click="applyFilters" class="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">Apply</button>
      <button @click="filters = { status: '', vendor_id: '', from: '', to: '' }; applyFilters()" class="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Clear</button>
    </div>

    <!-- Error -->
    <div v-if="error" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ error }}
    </div>

    <!-- Table -->
    <div class="rounded-xl bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
      <div v-if="loading" class="space-y-3 p-4">
        <div v-for="i in 5" :key="i" class="h-10 animate-pulse rounded-lg bg-gray-100" />
      </div>
      <div v-else-if="!settlements.length" class="py-16 text-center text-sm text-gray-400">
        No settlements found
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th class="px-4 py-3 text-left font-medium">Order ID</th>
              <th class="px-4 py-3 text-left font-medium">Vendor</th>
              <th class="px-4 py-3 text-right font-medium">Total</th>
              <th class="px-4 py-3 text-right font-medium">Commission</th>
              <th class="px-4 py-3 text-right font-medium">Payout</th>
              <th class="px-4 py-3 text-left font-medium">Status</th>
              <th class="px-4 py-3 text-left font-medium">Date</th>
              <th class="px-4 py-3 text-left font-medium">Action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            <tr v-for="s in settlements" :key="s.id" class="hover:bg-gray-50/50">
              <td class="px-4 py-3 font-mono text-xs text-gray-600">{{ s.ondc_order_id || s.order_id }}</td>
              <td class="px-4 py-3 text-gray-700">{{ s.vendor_name || '—' }}</td>
              <td class="px-4 py-3 text-right font-medium text-gray-900">{{ formatCurrency(s.total_amount) }}</td>
              <td class="px-4 py-3 text-right text-gray-500">{{ formatCurrency(s.platform_commission) }}</td>
              <td class="px-4 py-3 text-right font-semibold text-green-700">{{ formatCurrency(s.seller_payout) }}</td>
              <td class="px-4 py-3">
                <span :class="['rounded-full px-2 py-0.5 text-xs font-medium capitalize', statusClass[s.status] || 'bg-gray-100 text-gray-600']">
                  {{ s.status }}
                </span>
              </td>
              <td class="px-4 py-3 text-gray-500">{{ formatDate(s.created_at) }}</td>
              <td class="px-4 py-3">
                <button
                  v-if="s.status === 'pending'"
                  @click="processSettlement(s.id)"
                  :disabled="processing === s.id"
                  class="rounded-lg bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {{ processing === s.id ? 'Processing…' : 'Pay Out' }}
                </button>
                <span v-else-if="s.utr_number" class="font-mono text-xs text-gray-500">{{ s.utr_number }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div v-if="total > 50" class="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-sm text-gray-500">
        <span>{{ total }} total</span>
        <div class="flex gap-2">
          <button @click="page--; fetchSettlements()" :disabled="page === 1" class="rounded border border-gray-200 px-3 py-1 hover:bg-gray-50 disabled:opacity-40">Prev</button>
          <span class="px-2 py-1">Page {{ page }}</span>
          <button @click="page++; fetchSettlements()" :disabled="page * 50 >= total" class="rounded border border-gray-200 px-3 py-1 hover:bg-gray-50 disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
  </div>
</template>
