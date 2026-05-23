<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { get } from '@/utils/api'
import { RefreshCw, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-vue-next'

const loading = ref(true)
const error = ref(null)
const logs = ref([])
const total = ref(0)
const typeFilter = ref('')
const statusFilter = ref('')
const page = ref(1)
const perPage = 50
let timer = null

const typeOptions = [
  { value: '', label: 'All Types' },
  { value: 'catalog', label: 'Catalog' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'order', label: 'Order' },
]

const statusOptions = [
  { value: '', label: 'All Status' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
  { value: 'partial', label: 'Partial' },
]

const statusBadge = {
  success: 'bg-green-100 text-green-700',
  failed:  'bg-red-100 text-red-700',
  pending: 'bg-yellow-100 text-yellow-700',
  partial: 'bg-orange-100 text-orange-700',
}

const totalPages = computed(() => Math.ceil(total.value / perPage))

function duration(start, end) {
  if (!start || !end) return '—'
  const ms = new Date(end) - new Date(start)
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

async function fetchLogs() {
  loading.value = true
  error.value = null
  const { data, error: err } = await get('/dashboard/sync-logs', {
    type: typeFilter.value || undefined,
    status: statusFilter.value || undefined,
    page: page.value,
    per_page: perPage,
  })
  if (err) { error.value = err }
  else {
    logs.value = data?.logs || data?.data || []
    total.value = data?.total || logs.value.length
  }
  loading.value = false
}

function onFilter() { page.value = 1; fetchLogs() }

onMounted(() => {
  fetchLogs()
  timer = setInterval(fetchLogs, 30000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="p-6 space-y-5">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold text-gray-900">Sync Logs</h1>
      <button @click="fetchLogs" :disabled="loading" class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
        <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <div class="flex flex-col gap-3 sm:flex-row">
      <select v-model="typeFilter" @change="onFilter" class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500">
        <option v-for="opt in typeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <select v-model="statusFilter" @change="onFilter" class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500">
        <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
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
              <th class="px-5 py-3 text-left font-medium">Type</th>
              <th class="px-5 py-3 text-left font-medium">Status</th>
              <th class="px-5 py-3 text-right font-medium">Total</th>
              <th class="px-5 py-3 text-right font-medium">Synced</th>
              <th class="px-5 py-3 text-right font-medium">Failed</th>
              <th class="px-5 py-3 text-left font-medium">Started</th>
              <th class="px-5 py-3 text-left font-medium">Completed</th>
              <th class="px-5 py-3 text-left font-medium">Duration</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            <template v-if="loading">
              <tr v-for="i in 8" :key="i">
                <td v-for="j in 8" :key="j" class="px-5 py-3">
                  <div class="h-4 w-16 animate-pulse rounded bg-gray-100" />
                </td>
              </tr>
            </template>
            <template v-else-if="logs.length">
              <tr
                v-for="log in logs" :key="log.id"
                :class="log.status === 'failed' ? 'bg-red-50/40' : 'hover:bg-gray-50/50'"
              >
                <td class="px-5 py-3 font-medium capitalize text-gray-800">{{ log.type }}</td>
                <td class="px-5 py-3">
                  <span :class="['rounded-full px-2 py-0.5 text-xs font-medium capitalize', statusBadge[log.status] || 'bg-gray-100 text-gray-500']">
                    {{ log.status }}
                  </span>
                </td>
                <td class="px-5 py-3 text-right text-gray-700">{{ log.total_items ?? '—' }}</td>
                <td class="px-5 py-3 text-right text-green-700 font-medium">{{ log.synced ?? '—' }}</td>
                <td class="px-5 py-3 text-right" :class="log.failed > 0 ? 'text-red-600 font-semibold' : 'text-gray-500'">{{ log.failed ?? '—' }}</td>
                <td class="px-5 py-3 text-gray-500">{{ formatDate(log.started_at) }}</td>
                <td class="px-5 py-3 text-gray-500">{{ formatDate(log.completed_at) }}</td>
                <td class="px-5 py-3 font-mono text-xs text-gray-600">{{ duration(log.started_at, log.completed_at) }}</td>
              </tr>
            </template>
            <tr v-else>
              <td colspan="8" class="px-5 py-16 text-center">
                <RefreshCw class="mx-auto mb-3 h-10 w-10 text-gray-200" />
                <p class="text-sm text-gray-400">No sync logs found</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="totalPages > 1" class="flex items-center justify-between border-t border-gray-100 px-5 py-3 text-sm text-gray-600">
        <span>Page {{ page }} of {{ totalPages }}</span>
        <div class="flex gap-1">
          <button @click="page--; fetchLogs()" :disabled="page === 1" class="rounded p-1 hover:bg-gray-100 disabled:opacity-40"><ChevronLeft class="h-4 w-4" /></button>
          <button @click="page++; fetchLogs()" :disabled="page === totalPages" class="rounded p-1 hover:bg-gray-100 disabled:opacity-40"><ChevronRight class="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  </div>
</template>
