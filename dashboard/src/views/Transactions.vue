<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { get } from '@/utils/api'
import { RefreshCw, AlertCircle, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, ArrowDownLeft, ArrowUpRight } from 'lucide-vue-next'

const loading = ref(true)
const error   = ref(null)
const txns    = ref([])
const total   = ref(0)
const page    = ref(1)
const perPage = 50
const expanded = ref(null)
let timer = null

const filters = ref({ action: '', direction: '', status: '' })

const actions = ['search','select','init','confirm','status','cancel','track','update','issue','issue_status',
                 'on_search','on_select','on_init','on_confirm','on_status','on_cancel','on_track','on_update','on_issue','on_issue_status']

const directionBadge = {
  in:  'bg-blue-100 text-blue-700',
  out: 'bg-purple-100 text-purple-700',
}
const statusBadge = {
  success: 'bg-green-100 text-green-700',
  failed:  'bg-red-100 text-red-700',
  pending: 'bg-yellow-100 text-yellow-700',
}

const totalPages = computed(() => Math.ceil(total.value / perPage))

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function prettyJson(raw) {
  try { return JSON.stringify(typeof raw === 'string' ? JSON.parse(raw) : raw, null, 2) }
  catch { return raw || '' }
}

async function fetchTxns() {
  loading.value = true
  error.value   = null
  const params  = { page: page.value, per_page: perPage }
  if (filters.value.action)    params.action    = filters.value.action
  if (filters.value.direction) params.direction = filters.value.direction
  if (filters.value.status)    params.status    = filters.value.status

  const { data, error: err } = await get('/dashboard/transactions', params)
  if (err) { error.value = err }
  else {
    txns.value  = data?.transactions || []
    total.value = data?.total || 0
  }
  loading.value = false
}

function onFilter() { page.value = 1; fetchTxns() }
function toggleExpand(id) { expanded.value = expanded.value === id ? null : id }

onMounted(() => { fetchTxns(); timer = setInterval(fetchTxns, 15000) })
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="p-6 space-y-5">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-bold text-gray-900">ONDC Transactions</h1>
        <p class="text-sm text-gray-500 mt-0.5">All inbound & outbound ONDC API calls</p>
      </div>
      <button @click="fetchTxns" :disabled="loading" class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
        <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3">
      <select v-model="filters.action" @change="onFilter" class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500">
        <option value="">All Actions</option>
        <option v-for="a in actions" :key="a" :value="a">{{ a }}</option>
      </select>
      <select v-model="filters.direction" @change="onFilter" class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500">
        <option value="">All Directions</option>
        <option value="in">Inbound ↓</option>
        <option value="out">Outbound ↑</option>
      </select>
      <select v-model="filters.status" @change="onFilter" class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500">
        <option value="">All Status</option>
        <option value="success">Success</option>
        <option value="failed">Failed</option>
        <option value="pending">Pending</option>
      </select>
      <button @click="filters = { action: '', direction: '', status: '' }; onFilter()" class="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Clear</button>
    </div>

    <div v-if="error" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-sm text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ error }}
    </div>

    <!-- Stats bar -->
    <div class="text-xs text-gray-500 px-1">{{ total }} total transactions · auto-refreshes every 15s</div>

    <div class="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-100">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th class="px-4 py-3 text-left font-medium">Action</th>
              <th class="px-4 py-3 text-left font-medium">Direction</th>
              <th class="px-4 py-3 text-left font-medium">Transaction ID</th>
              <th class="px-4 py-3 text-left font-medium">BAP ID</th>
              <th class="px-4 py-3 text-left font-medium">Status</th>
              <th class="px-4 py-3 text-left font-medium">Time</th>
              <th class="px-4 py-3 text-left font-medium"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            <template v-if="loading">
              <tr v-for="i in 8" :key="i">
                <td v-for="j in 7" :key="j" class="px-4 py-3">
                  <div class="h-4 w-20 animate-pulse rounded bg-gray-100" />
                </td>
              </tr>
            </template>
            <template v-else-if="txns.length">
              <template v-for="t in txns" :key="t.id">
                <tr
                  class="cursor-pointer hover:bg-gray-50/60"
                  :class="t.status === 'failed' ? 'bg-red-50/30' : ''"
                  @click="toggleExpand(t.id)"
                >
                  <td class="px-4 py-3">
                    <div class="flex items-center gap-1.5">
                      <component
                        :is="t.direction === 'in' ? ArrowDownLeft : ArrowUpRight"
                        class="h-3.5 w-3.5 shrink-0"
                        :class="t.direction === 'in' ? 'text-blue-500' : 'text-purple-500'"
                      />
                      <span class="font-mono text-xs font-medium text-gray-800">{{ t.action }}</span>
                    </div>
                  </td>
                  <td class="px-4 py-3">
                    <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', directionBadge[t.direction] || 'bg-gray-100 text-gray-600']">
                      {{ t.direction === 'in' ? '↓ Inbound' : '↑ Outbound' }}
                    </span>
                  </td>
                  <td class="px-4 py-3 font-mono text-xs text-gray-500 max-w-[160px] truncate" :title="t.transaction_id">
                    {{ t.transaction_id || '—' }}
                  </td>
                  <td class="px-4 py-3 text-xs text-gray-600 max-w-[140px] truncate" :title="t.bap_id">
                    {{ t.bap_id || '—' }}
                  </td>
                  <td class="px-4 py-3">
                    <span :class="['rounded-full px-2 py-0.5 text-xs font-medium capitalize', statusBadge[t.status] || 'bg-gray-100 text-gray-600']">
                      {{ t.status }}
                    </span>
                  </td>
                  <td class="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{{ formatDate(t.created_at) }}</td>
                  <td class="px-4 py-3">
                    <component :is="expanded === t.id ? ChevronUp : ChevronDown" class="h-4 w-4 text-gray-400" />
                  </td>
                </tr>

                <!-- Expanded payload viewer -->
                <tr v-if="expanded === t.id" class="bg-gray-900">
                  <td colspan="7" class="px-4 py-4">
                    <div class="grid grid-cols-1 gap-3" :class="t.response ? 'lg:grid-cols-2' : ''">
                      <div>
                        <div class="text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">Request Payload</div>
                        <pre class="whitespace-pre-wrap break-all rounded-lg bg-gray-800 p-3 text-xs text-green-300 font-mono max-h-80 overflow-y-auto">{{ prettyJson(t.payload) }}</pre>
                      </div>
                      <div v-if="t.response">
                        <div class="text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wide">Response</div>
                        <pre class="whitespace-pre-wrap break-all rounded-lg bg-gray-800 p-3 text-xs text-yellow-300 font-mono max-h-80 overflow-y-auto">{{ prettyJson(t.response) }}</pre>
                      </div>
                    </div>
                    <div class="mt-2 text-xs text-gray-500">
                      Msg ID: <span class="font-mono text-gray-400">{{ t.message_id }}</span>
                    </div>
                  </td>
                </tr>
              </template>
            </template>
            <tr v-else>
              <td colspan="7" class="px-4 py-16 text-center">
                <ArrowDownLeft class="mx-auto mb-3 h-10 w-10 text-gray-200" />
                <p class="text-sm text-gray-400">No transactions yet</p>
                <p class="text-xs text-gray-300 mt-1">Transactions will appear here when Pramaan calls your BPP</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="totalPages > 1" class="flex items-center justify-between border-t border-gray-100 px-5 py-3 text-sm text-gray-600">
        <span>Page {{ page }} of {{ totalPages }} ({{ total }} total)</span>
        <div class="flex gap-1">
          <button @click="page--; fetchTxns()" :disabled="page === 1" class="rounded p-1 hover:bg-gray-100 disabled:opacity-40"><ChevronLeft class="h-4 w-4" /></button>
          <button @click="page++; fetchTxns()" :disabled="page === totalPages" class="rounded p-1 hover:bg-gray-100 disabled:opacity-40"><ChevronRight class="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  </div>
</template>
