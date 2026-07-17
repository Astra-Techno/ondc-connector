<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { get } from '@/utils/api'
import { RefreshCw, AlertCircle, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Download } from 'lucide-vue-next'

const loading = ref(true)
const error = ref(null)
const logs = ref([])
const total = ref(0)
const typeFilter = ref('')
const statusFilter = ref('')
const page = ref(1)
const perPage = 50
const expanded = ref(null)
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
  { value: 'partial', label: 'Partial' },
]

const statusBadge = {
  success: 'bg-green-100 text-green-700',
  failed:  'bg-red-100 text-red-700',
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
    type:     typeFilter.value  || undefined,
    status:   statusFilter.value || undefined,
    page:     page.value,
    per_page: perPage,
  })
  if (err) { error.value = err }
  else {
    logs.value  = data?.logs || data?.data || []
    total.value = data?.total || logs.value.length
  }
  loading.value = false
}

function onFilter() { page.value = 1; fetchLogs() }

function toggleExpand(id) {
  expanded.value = expanded.value === id ? null : id
}

function downloadLog(log) {
  const content = JSON.stringify({
    id:             log.id,
    type:           log.sync_type,
    status:         log.status,
    records_synced: log.records_synced,
    records_failed: log.records_failed,
    details:        log.details,
    started_at:     log.started_at,
    completed_at:   log.completed_at,
  }, null, 2)
  const blob = new Blob([content], { type: 'application/json' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `sync-log-${log.id}-${log.sync_type}.json`
  a.click()
  URL.revokeObjectURL(url)
}

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
              <th class="px-5 py-3 text-right font-medium">Synced</th>
              <th class="px-5 py-3 text-right font-medium">Failed</th>
              <th class="px-5 py-3 text-left font-medium">Started</th>
              <th class="px-5 py-3 text-left font-medium">Duration</th>
              <th class="px-5 py-3 text-left font-medium">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            <template v-if="loading">
              <tr v-for="i in 8" :key="i">
                <td v-for="j in 7" :key="j" class="px-5 py-3">
                  <div class="h-4 w-16 animate-pulse rounded bg-gray-100" />
                </td>
              </tr>
            </template>
            <template v-else-if="logs.length">
              <template v-for="log in logs" :key="log.id">
                <tr
                  class="cursor-pointer"
                  :class="log.status === 'failed' ? 'bg-red-50/40 hover:bg-red-50' : 'hover:bg-gray-50/50'"
                  @click="toggleExpand(log.id)"
                >
                  <td class="px-5 py-3 font-medium capitalize text-gray-800">{{ log.sync_type }}</td>
                  <td class="px-5 py-3">
                    <span :class="['rounded-full px-2 py-0.5 text-xs font-medium capitalize', statusBadge[log.status] || 'bg-gray-100 text-gray-500']">
                      {{ log.status }}
                    </span>
                  </td>
                  <td class="px-5 py-3 text-right text-green-700 font-medium">{{ log.records_synced ?? '—' }}</td>
                  <td class="px-5 py-3 text-right" :class="log.records_failed > 0 ? 'text-red-600 font-semibold' : 'text-gray-500'">{{ log.records_failed ?? '—' }}</td>
                  <td class="px-5 py-3 text-gray-500">{{ formatDate(log.started_at) }}</td>
                  <td class="px-5 py-3 font-mono text-xs text-gray-600">{{ duration(log.started_at, log.completed_at) }}</td>
                  <td class="px-5 py-3">
                    <div class="flex items-center gap-2">
                      <button
                        @click.stop="downloadLog(log)"
                        class="flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                        title="Download log as JSON"
                      >
                        <Download class="h-3 w-3" /> Download
                      </button>
                      <component :is="expanded === log.id ? ChevronUp : ChevronDown" class="h-4 w-4 text-gray-400" />
                    </div>
                  </td>
                </tr>

                <!-- Expanded details row -->
                <tr v-if="expanded === log.id" :class="log.status === 'failed' ? 'bg-red-50/60' : 'bg-gray-50/60'">
                  <td colspan="7" class="px-5 py-4">
                    <div class="text-xs text-gray-500 mb-1 font-medium uppercase tracking-wide">Details / Error</div>
                    <pre v-if="log.details" class="whitespace-pre-wrap break-all rounded-lg bg-gray-900 p-4 text-xs text-green-300 font-mono max-h-64 overflow-y-auto">{{ log.details }}</pre>
                    <p v-else class="text-sm text-gray-400 italic">No details recorded</p>
                    <div class="mt-2 flex gap-6 text-xs text-gray-500">
                      <span>Started: {{ formatDate(log.started_at) }}</span>
                      <span>Completed: {{ formatDate(log.completed_at) }}</span>
                      <span>Duration: {{ duration(log.started_at, log.completed_at) }}</span>
                    </div>
                  </td>
                </tr>
              </template>
            </template>
            <tr v-else>
              <td colspan="7" class="px-5 py-16 text-center">
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
