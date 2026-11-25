<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { get, put } from '@/utils/api'
import { useToast } from '@/stores/toast'
import { useRouter } from 'vue-router'
import {
  AlertCircle, RefreshCw, CheckCircle, Clock, MessageSquare, X,
  Search, ChevronRight, ArrowDownLeft, ArrowUpRight, Shield,
  FileText, ExternalLink, User, Package, Hash, Calendar,
  ChevronDown, ChevronUp, Zap,
} from 'lucide-vue-next'

const toast   = useToast()
const router  = useRouter()
const loading = ref(true)
const err     = ref(null)
const issues  = ref([])
const total   = ref(0)
const page    = ref(1)
const summary = ref({ open: 0, in_progress: 0, resolved: 0, closed: 0 })
const filters = ref({ status: '', search: '' })

// Detail panel
const detail        = ref(null)
const detailLoading = ref(false)
const showDetail    = ref(false)
const expandedPayload = ref(null)

const statusConfig = {
  open:        { color: 'bg-red-100 text-red-700 ring-red-200',     icon: AlertCircle, dot: 'bg-red-500' },
  in_progress: { color: 'bg-yellow-100 text-yellow-700 ring-yellow-200', icon: Clock, dot: 'bg-yellow-500' },
  resolved:    { color: 'bg-green-100 text-green-700 ring-green-200',  icon: CheckCircle, dot: 'bg-green-500' },
  closed:      { color: 'bg-gray-100 text-gray-600 ring-gray-200',   icon: X, dot: 'bg-gray-500' },
}

const actionColors = {
  OPEN:                 'bg-red-50 text-red-700 border-red-200',
  PROCESSING:           'bg-yellow-50 text-yellow-700 border-yellow-200',
  'NEED-MORE-INFO':     'bg-orange-50 text-orange-700 border-orange-200',
  INFO_PROVIDED:        'bg-blue-50 text-blue-700 border-blue-200',
  RESOLUTION_PROPOSED:  'bg-indigo-50 text-indigo-700 border-indigo-200',
  RESOLUTION_ACCEPTED:  'bg-emerald-50 text-emerald-700 border-emerald-200',
  RESOLUTION_REJECTED:  'bg-pink-50 text-pink-700 border-pink-200',
  ESCALATED:            'bg-purple-50 text-purple-700 border-purple-200',
  RESOLVED:             'bg-green-50 text-green-700 border-green-200',
  CLOSED:               'bg-gray-50 text-gray-600 border-gray-200',
}

async function fetchIssues() {
  loading.value = true
  err.value     = null
  const params  = { page: page.value, per_page: 50 }
  if (filters.value.status) params.status = filters.value.status
  if (filters.value.search) params.search = filters.value.search

  const { data, error: e } = await get('/igm', params)
  if (e) { err.value = e }
  else {
    issues.value  = data?.issues || []
    total.value   = data?.total || 0
    summary.value = data?.summary || { open: 0, in_progress: 0, resolved: 0, closed: 0 }
  }
  loading.value = false
}

async function openDetail(issue) {
  showDetail.value    = true
  detailLoading.value = true
  detail.value        = null
  expandedPayload.value = null

  const { data, error: e } = await get(`/igm/${issue.id}`)
  if (e) { toast.error(e); showDetail.value = false }
  else { detail.value = data }
  detailLoading.value = false
}

function closeDetail() {
  showDetail.value = false
  detail.value     = null
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function applyFilters() { page.value = 1; fetchIssues() }

function goToOrder(orderId) {
  if (orderId) router.push(`/orders/${orderId}`)
}

function goToWorkflow(txnId) {
  if (txnId) router.push(`/igm-workflow`)
}

function prettyJson(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    return JSON.stringify(obj, null, 2)
  } catch { return raw || '' }
}

onMounted(fetchIssues)
</script>

<template>
  <div class="p-6 space-y-6 max-w-7xl mx-auto">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 flex items-center gap-3">
          <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 shadow-lg shadow-green-200">
            <Shield class="h-5 w-5 text-white" />
          </div>
          Issue & Grievance Management
        </h1>
        <p class="text-sm text-gray-500 mt-1 ml-[52px]">ONDC IGM complaint tracking and resolution</p>
      </div>
      <button @click="fetchIssues" :disabled="loading"
        class="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
        <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" /> Refresh
      </button>
    </div>

    <!-- Summary Cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <button v-for="(cfg, key) in statusConfig" :key="key"
        @click="filters.status = filters.status === key ? '' : key; applyFilters()"
        :class="[
          'rounded-xl p-4 text-left transition-all ring-1',
          filters.status === key ? 'ring-2 ring-green-500 shadow-md' : 'ring-gray-100 hover:ring-gray-200',
          'bg-white shadow-sm'
        ]">
        <div class="flex items-center justify-between mb-2">
          <span :class="['flex h-8 w-8 items-center justify-center rounded-lg', cfg.color]">
            <component :is="cfg.icon" class="h-4 w-4" />
          </span>
          <span class="text-2xl font-bold text-gray-900">{{ summary[key] || 0 }}</span>
        </div>
        <span class="text-xs font-medium text-gray-500 capitalize">{{ key.replace('_', ' ') }}</span>
      </button>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100">
      <div class="relative flex-1 min-w-[200px]">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input v-model="filters.search" @keyup.enter="applyFilters" placeholder="Search issue ID, order ID, description..."
          class="w-full rounded-lg border border-gray-200 pl-9 pr-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500" />
      </div>
      <select v-model="filters.status"
        class="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500">
        <option value="">All Status</option>
        <option value="open">Open</option>
        <option value="in_progress">In Progress</option>
        <option value="resolved">Resolved</option>
        <option value="closed">Closed</option>
      </select>
      <button @click="applyFilters"
        class="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">Search</button>
      <button @click="filters.status = ''; filters.search = ''; applyFilters()"
        class="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Clear</button>
    </div>

    <!-- Error -->
    <div v-if="err" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ err }}
    </div>

    <!-- Table -->
    <div class="rounded-xl bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
      <div v-if="loading" class="space-y-3 p-4">
        <div v-for="i in 5" :key="i" class="h-12 animate-pulse rounded-lg bg-gray-100" />
      </div>
      <div v-else-if="!issues.length" class="py-16 text-center text-sm text-gray-400">
        <Shield class="mx-auto mb-2 h-8 w-8 text-gray-200" />
        No issues found
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th class="px-4 py-3 text-left font-medium">Issue ID</th>
              <th class="px-4 py-3 text-left font-medium">Order</th>
              <th class="px-4 py-3 text-left font-medium">Category</th>
              <th class="px-4 py-3 text-left font-medium">Description</th>
              <th class="px-4 py-3 text-left font-medium">Complainant</th>
              <th class="px-4 py-3 text-left font-medium">Status</th>
              <th class="px-4 py-3 text-left font-medium">Raised</th>
              <th class="px-4 py-3 text-left font-medium"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            <tr v-for="issue in issues" :key="issue.id"
              class="hover:bg-gray-50/50 cursor-pointer" @click="openDetail(issue)">
              <td class="px-4 py-3">
                <span class="font-mono text-xs text-gray-600">{{ issue.issue_id?.substring(0, 8) }}…</span>
              </td>
              <td class="px-4 py-3 font-mono text-xs text-gray-600">{{ issue.order_id || '—' }}</td>
              <td class="px-4 py-3">
                <span v-if="issue.descriptor_code || issue.category"
                  class="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                  {{ issue.descriptor_code || issue.category }}
                </span>
                <span v-else class="text-gray-400">—</span>
              </td>
              <td class="px-4 py-3 max-w-[200px] truncate text-gray-700" :title="issue.description">
                {{ issue.description || '—' }}
              </td>
              <td class="px-4 py-3 text-gray-600 text-xs">
                {{ issue.complainant_name || '—' }}
              </td>
              <td class="px-4 py-3">
                <span :class="['flex items-center gap-1 w-fit rounded-full px-2.5 py-1 text-xs font-medium capitalize ring-1',
                  statusConfig[issue.status]?.color || 'bg-gray-100 text-gray-600 ring-gray-200']">
                  <span class="h-1.5 w-1.5 rounded-full" :class="statusConfig[issue.status]?.dot || 'bg-gray-400'" />
                  {{ issue.status?.replace('_', ' ') }}
                </span>
              </td>
              <td class="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{{ formatDate(issue.created_at) }}</td>
              <td class="px-4 py-3">
                <ChevronRight class="h-4 w-4 text-gray-300" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div v-if="total > 50" class="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-sm text-gray-500">
        <span>{{ total }} total</span>
        <div class="flex gap-2">
          <button @click="page--; fetchIssues()" :disabled="page === 1"
            class="rounded border border-gray-200 px-3 py-1 hover:bg-gray-50 disabled:opacity-40">Prev</button>
          <span class="px-2 py-1">Page {{ page }}</span>
          <button @click="page++; fetchIssues()" :disabled="page * 50 >= total"
            class="rounded border border-gray-200 px-3 py-1 hover:bg-gray-50 disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    <!-- DETAIL SLIDE-OVER PANEL                                                -->
    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <Transition enter-active-class="transition-opacity duration-200" enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
        <div v-if="showDetail" class="fixed inset-0 z-50 flex justify-end bg-black/30" @click.self="closeDetail">
          <Transition enter-active-class="transition-transform duration-300 ease-out" enter-from-class="translate-x-full"
            enter-to-class="translate-x-0" leave-active-class="transition-transform duration-200 ease-in"
            leave-from-class="translate-x-0" leave-to-class="translate-x-full">
            <div v-if="showDetail" class="w-full max-w-2xl bg-white shadow-2xl overflow-y-auto">
              <!-- Panel header -->
              <div class="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-6 py-4">
                <h2 class="font-semibold text-gray-900 flex items-center gap-2">
                  <Shield class="h-4 w-4 text-green-600" />
                  Complaint Detail
                </h2>
                <button @click="closeDetail" class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
                  <X class="h-5 w-5" />
                </button>
              </div>

              <!-- Loading -->
              <div v-if="detailLoading" class="p-6 space-y-4">
                <div v-for="i in 6" :key="i" class="h-12 animate-pulse rounded-xl bg-gray-100" />
              </div>

              <!-- Content -->
              <div v-else-if="detail" class="p-6 space-y-6">

                <!-- ── Issue Summary ───────────────────────────────────────── -->
                <div class="rounded-xl bg-gray-50 p-5 space-y-3">
                  <div class="flex items-start justify-between">
                    <div>
                      <div class="text-xs text-gray-400 mb-1">Issue ID</div>
                      <div class="font-mono text-sm text-gray-800">{{ detail.issue_id }}</div>
                    </div>
                    <span :class="['flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium capitalize ring-1',
                      statusConfig[detail.status]?.color || 'bg-gray-100 text-gray-600 ring-gray-200']">
                      <span class="h-1.5 w-1.5 rounded-full" :class="statusConfig[detail.status]?.dot || 'bg-gray-400'" />
                      {{ detail.status?.replace('_', ' ') }}
                    </span>
                  </div>

                  <div class="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span class="text-xs text-gray-400">Category</span>
                      <div class="text-gray-800 font-medium">{{ detail.descriptor_code || detail.category || '—' }}</div>
                    </div>
                    <div>
                      <span class="text-xs text-gray-400">Order ID</span>
                      <div class="flex items-center gap-1">
                        <span class="font-mono text-gray-800">{{ detail.order_id || '—' }}</span>
                        <button v-if="detail.linkedOrder" @click="goToOrder(detail.linkedOrder.id)"
                          class="text-green-600 hover:text-green-700">
                          <ExternalLink class="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <div>
                      <span class="text-xs text-gray-400">Description</span>
                      <div class="text-gray-700">{{ detail.description || '—' }}</div>
                    </div>
                    <div>
                      <span class="text-xs text-gray-400">Complainant</span>
                      <div class="text-gray-700">{{ detail.complainant_name || '—' }}</div>
                      <div class="text-xs text-gray-400">{{ detail.complainant_phone }}</div>
                    </div>
                  </div>

                  <div class="grid grid-cols-3 gap-3 text-xs border-t border-gray-200 pt-3">
                    <div>
                      <span class="text-gray-400">Raised</span>
                      <div class="text-gray-600">{{ formatDate(detail.created_at) }}</div>
                    </div>
                    <div>
                      <span class="text-gray-400">Resolved</span>
                      <div class="text-gray-600">{{ formatDate(detail.resolved_at) }}</div>
                    </div>
                    <div>
                      <span class="text-gray-400">Closed</span>
                      <div class="text-gray-600">{{ formatDate(detail.closed_at) }}</div>
                    </div>
                  </div>
                </div>

                <!-- ── Linked Order ────────────────────────────────────────── -->
                <div v-if="detail.linkedOrder" class="rounded-xl bg-blue-50/50 p-4 ring-1 ring-blue-100">
                  <div class="flex items-center gap-2 mb-2">
                    <Package class="h-4 w-4 text-blue-600" />
                    <span class="text-sm font-semibold text-blue-800">Linked Order</span>
                  </div>
                  <div class="grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <span class="text-blue-400">Order #</span>
                      <div class="font-mono text-blue-800">{{ detail.linkedOrder.ondc_order_id }}</div>
                    </div>
                    <div>
                      <span class="text-blue-400">Status</span>
                      <div class="text-blue-800 capitalize">{{ detail.linkedOrder.status }}</div>
                    </div>
                    <div>
                      <span class="text-blue-400">Amount</span>
                      <div class="text-blue-800">₹{{ detail.linkedOrder.total_amount }}</div>
                    </div>
                  </div>
                </div>

                <!-- ── Parsed refs (provider, item, fulfillment) ───────────── -->
                <div v-if="detail.parsed" class="rounded-xl bg-white p-4 ring-1 ring-gray-100">
                  <div class="flex items-center gap-2 mb-3">
                    <Hash class="h-4 w-4 text-gray-500" />
                    <span class="text-sm font-semibold text-gray-700">References</span>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <span v-if="detail.parsed.providerId"
                      class="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">
                      Provider: <strong>{{ detail.parsed.providerId }}</strong>
                    </span>
                    <span v-if="detail.parsed.itemId"
                      class="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">
                      Item: <strong>{{ detail.parsed.itemId }}</strong>
                    </span>
                    <span v-if="detail.parsed.fulfillmentId"
                      class="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">
                      Fulfillment: <strong>{{ detail.parsed.fulfillmentId }}</strong>
                    </span>
                  </div>
                </div>

                <!-- ── Action Timeline ─────────────────────────────────────── -->
                <div v-if="detail.parsed?.actions?.length" class="rounded-xl bg-white p-4 ring-1 ring-gray-100">
                  <div class="flex items-center gap-2 mb-4">
                    <Zap class="h-4 w-4 text-indigo-500" />
                    <span class="text-sm font-semibold text-gray-700">Action Timeline</span>
                    <span class="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">
                      {{ detail.parsed.actions.length }} actions
                    </span>
                  </div>
                  <div class="relative pl-6 space-y-0">
                    <!-- Vertical line -->
                    <div class="absolute left-[11px] top-2 bottom-2 w-px bg-gray-200" />

                    <div v-for="(act, idx) in detail.parsed.actions" :key="idx"
                      class="relative pb-4 last:pb-0">
                      <!-- Dot -->
                      <div :class="['absolute -left-[13px] top-1 h-3 w-3 rounded-full border-2 border-white',
                        actionColors[act.code]?.includes('red') ? 'bg-red-500'
                        : actionColors[act.code]?.includes('green') ? 'bg-green-500'
                        : actionColors[act.code]?.includes('yellow') ? 'bg-yellow-500'
                        : actionColors[act.code]?.includes('blue') ? 'bg-blue-500'
                        : actionColors[act.code]?.includes('indigo') ? 'bg-indigo-500'
                        : actionColors[act.code]?.includes('orange') ? 'bg-orange-500'
                        : actionColors[act.code]?.includes('pink') ? 'bg-pink-500'
                        : actionColors[act.code]?.includes('purple') ? 'bg-purple-500'
                        : actionColors[act.code]?.includes('emerald') ? 'bg-emerald-500'
                        : 'bg-gray-400'
                      ]" />

                      <!-- Action card -->
                      <div :class="['rounded-lg border px-3 py-2',
                        actionColors[act.code] || 'bg-gray-50 text-gray-700 border-gray-200'
                      ]">
                        <div class="flex items-center justify-between">
                          <span class="text-xs font-bold">{{ act.code }}</span>
                          <span class="text-[10px] text-gray-400">{{ formatTime(act.updated_at) }}</span>
                        </div>
                        <div v-if="act.short_desc && act.short_desc !== act.code"
                          class="text-[11px] mt-0.5 opacity-70">{{ act.short_desc }}</div>
                        <div v-if="act.action_by" class="text-[10px] mt-0.5 opacity-50">
                          by {{ act.action_by }}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- ── Resolutions ─────────────────────────────────────────── -->
                <div v-if="detail.parsed?.resolutions?.length" class="rounded-xl bg-white p-4 ring-1 ring-gray-100">
                  <div class="flex items-center gap-2 mb-3">
                    <FileText class="h-4 w-4 text-green-500" />
                    <span class="text-sm font-semibold text-gray-700">Resolution Options</span>
                  </div>

                  <div class="space-y-2">
                    <div v-for="res in detail.parsed.resolutions.filter(r => r.code !== 'PARENT')" :key="res.id"
                      :class="[
                        'rounded-lg border p-3 text-sm',
                        detail.parsed.acceptedResolution?.id === res.id
                          ? 'border-green-300 bg-green-50'
                          : 'border-gray-200 bg-gray-50'
                      ]">
                      <div class="flex items-center justify-between">
                        <span class="font-medium">{{ res.code }}</span>
                        <span v-if="detail.parsed.acceptedResolution?.id === res.id"
                          class="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
                          <CheckCircle class="h-3 w-3" /> Accepted
                        </span>
                        <span v-else class="text-xs text-gray-400">Proposed</span>
                      </div>
                      <div class="text-xs text-gray-500 mt-1">{{ res.short_desc }}</div>
                    </div>
                  </div>
                </div>

                <!-- ── Protocol Timeline ───────────────────────────────────── -->
                <div v-if="detail.protocolTimeline?.length" class="rounded-xl bg-white p-4 ring-1 ring-gray-100">
                  <div class="flex items-center justify-between mb-3">
                    <div class="flex items-center gap-2">
                      <MessageSquare class="h-4 w-4 text-gray-500" />
                      <span class="text-sm font-semibold text-gray-700">Protocol Log</span>
                      <span class="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">
                        {{ detail.protocolTimeline.length }} messages
                      </span>
                    </div>
                    <button v-if="detail.transaction_id" @click="goToWorkflow(detail.transaction_id)"
                      class="flex items-center gap-1 text-xs text-green-600 hover:text-green-700">
                      Full timeline <ExternalLink class="h-3 w-3" />
                    </button>
                  </div>

                  <div class="space-y-1.5 max-h-64 overflow-y-auto">
                    <div v-for="t in detail.protocolTimeline" :key="t.id"
                      class="flex items-center gap-3 rounded-lg px-3 py-2 text-xs hover:bg-gray-50">
                      <span :class="[
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                        t.direction === 'inbound'
                          ? 'bg-blue-100 text-blue-600'
                          : 'bg-green-100 text-green-600'
                      ]">
                        <component :is="t.direction === 'inbound' ? ArrowDownLeft : ArrowUpRight" class="h-3 w-3" />
                      </span>
                      <span class="font-mono font-bold text-gray-700 w-28">{{ t.action }}</span>
                      <span v-if="t.issue_status" :class="['rounded-full px-2 py-0.5 text-[10px] font-medium ring-1',
                        statusConfig[t.issue_status?.toLowerCase()]?.color || 'bg-gray-100 text-gray-600 ring-gray-200']">
                        {{ t.issue_status }}
                      </span>
                      <span class="ml-auto text-gray-400">{{ formatTime(t.created_at) }}</span>
                    </div>
                  </div>
                </div>

                <!-- ── Raw Payload (collapsed) ─────────────────────────────── -->
                <div v-if="detail.raw_payload" class="rounded-xl bg-white ring-1 ring-gray-100 overflow-hidden">
                  <button @click="expandedPayload = expandedPayload ? null : 'raw'"
                    class="flex items-center justify-between w-full px-4 py-3 text-sm text-gray-600 hover:bg-gray-50">
                    <span class="flex items-center gap-2">
                      <FileText class="h-4 w-4 text-gray-400" />
                      Raw ONDC Payload
                    </span>
                    <component :is="expandedPayload === 'raw' ? ChevronUp : ChevronDown" class="h-4 w-4 text-gray-400" />
                  </button>
                  <div v-if="expandedPayload === 'raw'" class="border-t border-gray-100">
                    <pre class="p-4 text-[11px] text-gray-600 font-mono whitespace-pre-wrap break-all max-h-80 overflow-y-auto bg-gray-900 text-green-300">{{ prettyJson(detail.raw_payload) }}</pre>
                  </div>
                </div>

              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
