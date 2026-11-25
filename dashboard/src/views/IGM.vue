<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { get, put, post } from '@/utils/api'
import { useToast } from '@/stores/toast'
import { useRouter } from 'vue-router'
import {
  AlertCircle, RefreshCw, CheckCircle, Clock, MessageSquare, X,
  Search, ChevronRight, ArrowDownLeft, ArrowUpRight, Shield,
  FileText, ExternalLink, User, Package, Hash, Calendar,
  ChevronDown, ChevronUp, Zap, Copy, Filter, ArrowUpDown,
  ThumbsUp, ThumbsDown, Info, Tag, AlertTriangle, Link,
  Award, Eye, Paperclip, Building,
} from 'lucide-vue-next'

const toast   = useToast()
const router  = useRouter()
const loading = ref(true)
const err     = ref(null)
const issues  = ref([])
const total   = ref(0)
const page    = ref(1)
const perPage = ref(50)
const summary = ref({ open: 0, in_progress: 0, resolved: 0, closed: 0 })
const categories = ref([])
const filters = ref({ status: '', search: '', category: '', date_from: '', date_to: '' })
const sortBy  = ref('created_at')
const sortDir = ref('DESC')
const showFilters = ref(false)

// Detail panel
const detail          = ref(null)
const detailLoading   = ref(false)
const showDetail      = ref(false)
const rawPayload      = ref(null)
const rawLoading      = ref(false)
const showRaw         = ref(false)
const copiedField     = ref(null)
const protocolFilter  = ref('igm') // 'igm' or 'all'

const statusConfig = {
  open:        { label: 'Open',        color: 'bg-red-100 text-red-700 ring-red-200',     icon: AlertCircle, dot: 'bg-red-500',    cardBg: 'bg-red-50' },
  in_progress: { label: 'In Progress', color: 'bg-yellow-100 text-yellow-700 ring-yellow-200', icon: Clock, dot: 'bg-yellow-500', cardBg: 'bg-yellow-50' },
  resolved:    { label: 'Resolved',    color: 'bg-green-100 text-green-700 ring-green-200',  icon: CheckCircle, dot: 'bg-green-500', cardBg: 'bg-green-50' },
  closed:      { label: 'Closed',      color: 'bg-gray-100 text-gray-600 ring-gray-200',   icon: X, dot: 'bg-gray-500',           cardBg: 'bg-gray-50' },
}

const actionColors = {
  OPEN:                 { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', dot: 'bg-red-500' },
  PROCESSING:           { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200', dot: 'bg-yellow-500' },
  'NEED-MORE-INFO':     { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200', dot: 'bg-orange-500' },
  INFO_PROVIDED:        { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', dot: 'bg-blue-500' },
  RESOLUTION_PROPOSED:  { bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200', dot: 'bg-indigo-500' },
  RESOLUTION_ACCEPTED:  { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', dot: 'bg-emerald-500' },
  RESOLUTION_REJECTED:  { bg: 'bg-pink-50', text: 'text-pink-700', border: 'border-pink-200', dot: 'bg-pink-500' },
  ESCALATED:            { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', dot: 'bg-purple-500' },
  RESOLVED:             { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', dot: 'bg-green-500' },
  CLOSED:               { bg: 'bg-gray-50', text: 'text-gray-600', border: 'border-gray-200', dot: 'bg-gray-500' },
}

const actionClass = (code) => {
  const c = actionColors[code] || { bg: 'bg-gray-50', text: 'text-gray-700', border: 'border-gray-200', dot: 'bg-gray-400' }
  return `${c.bg} ${c.text} ${c.border}`
}
const actionDot = (code) => (actionColors[code] || { dot: 'bg-gray-400' }).dot

const totalPages = computed(() => Math.ceil(total.value / perPage.value) || 1)

const descriptorLabels = {
  ORD01: 'Missing item',
  ORD02: 'Unsatisfactory order',
  ORD03: 'Delayed delivery',
  ORD04: 'Wrong item delivered',
  ORD05: 'Quality issue',
  FLM01: 'Fulfillment issue',
  FLM02: 'Delivery not attempted',
  ITM01: 'Item damaged',
  ITM02: 'Item expired',
}

function categoryLabel(code) {
  return descriptorLabels[code] || code || '—'
}

async function fetchIssues() {
  loading.value = true
  err.value     = null
  const params  = { page: page.value, per_page: perPage.value, sort_by: sortBy.value, sort_dir: sortDir.value }
  if (filters.value.status) params.status = filters.value.status
  if (filters.value.search) params.search = filters.value.search
  if (filters.value.category) params.category = filters.value.category
  if (filters.value.date_from) params.date_from = filters.value.date_from
  if (filters.value.date_to) params.date_to = filters.value.date_to

  const { data, error: e } = await get('/igm', params)
  if (e) { err.value = e }
  else {
    issues.value     = data?.issues || []
    total.value      = data?.total || 0
    summary.value    = data?.summary || { open: 0, in_progress: 0, resolved: 0, closed: 0 }
    categories.value = data?.categories || []
  }
  loading.value = false
}

async function openDetail(issue) {
  showDetail.value    = true
  detailLoading.value = true
  detail.value        = null
  rawPayload.value    = null
  showRaw.value       = false
  protocolFilter.value = 'igm'

  const { data, error: e } = await get(`/igm/${issue.id}`)
  if (e) { toast.error(e); showDetail.value = false }
  else { detail.value = data }
  detailLoading.value = false
}

const filteredProtocol = computed(() => {
  if (!detail.value) return []
  if (protocolFilter.value === 'igm') return detail.value.igmTimeline || []
  return detail.value.protocolTimeline || []
})

async function loadRawPayload() {
  if (rawPayload.value || !detail.value) return
  rawLoading.value = true
  const { data } = await get(`/igm/${detail.value.id}/raw`)
  rawPayload.value = data
  rawLoading.value = false
}

async function toggleRaw() {
  showRaw.value = !showRaw.value
  if (showRaw.value && !rawPayload.value) await loadRawPayload()
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

function formatFullDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatElapsed(ms) {
  if (!ms || ms < 0) return null
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`
  const h = Math.floor(m / 60)
  const remM = m % 60
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`
}

function applyFilters() { page.value = 1; fetchIssues() }

function clearFilters() {
  filters.value = { status: '', search: '', category: '', date_from: '', date_to: '' }
  applyFilters()
}

function toggleSort(col) {
  if (sortBy.value === col) {
    sortDir.value = sortDir.value === 'DESC' ? 'ASC' : 'DESC'
  } else {
    sortBy.value = col
    sortDir.value = 'DESC'
  }
  fetchIssues()
}

function goToOrder(orderId) {
  if (orderId) router.push(`/orders/${orderId}`)
}

function goToWorkflow(txnId) {
  if (txnId) router.push(`/igm-workflow`)
}

async function copyText(text, field) {
  try {
    await navigator.clipboard.writeText(text)
    copiedField.value = field
    setTimeout(() => { copiedField.value = null }, 1500)
  } catch (_) {}
}

function prettyJson(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    return JSON.stringify(obj, null, 2)
  } catch { return raw || '' }
}

const hasActiveFilters = computed(() =>
  filters.value.category || filters.value.date_from || filters.value.date_to
)

onMounted(fetchIssues)
</script>

<template>
  <div class="p-4 md:p-6 space-y-5 max-w-7xl mx-auto">
    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-xl md:text-2xl font-bold text-gray-900 flex items-center gap-3">
          <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 shadow-lg shadow-green-200">
            <Shield class="h-5 w-5 text-white" />
          </div>
          Issue &amp; Grievance Management
        </h1>
        <p class="text-sm text-gray-500 mt-1 ml-[52px]">ONDC IGM complaint tracking and resolution</p>
      </div>
      <button @click="fetchIssues" :disabled="loading"
        class="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 shadow-sm">
        <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" /> Refresh
      </button>
    </div>

    <!-- Summary Cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
      <button v-for="(cfg, key) in statusConfig" :key="key"
        @click="filters.status = filters.status === key ? '' : key; applyFilters()"
        :class="[
          'rounded-xl p-3 md:p-4 text-left transition-all ring-1',
          filters.status === key ? 'ring-2 ring-green-500 shadow-md' : 'ring-gray-100 hover:ring-gray-200',
          'bg-white shadow-sm'
        ]">
        <div class="flex items-center justify-between mb-2">
          <span :class="['flex h-7 w-7 md:h-8 md:w-8 items-center justify-center rounded-lg', cfg.color]">
            <component :is="cfg.icon" class="h-3.5 w-3.5 md:h-4 md:w-4" />
          </span>
          <span class="text-xl md:text-2xl font-bold text-gray-900">{{ summary[key] || 0 }}</span>
        </div>
        <span class="text-xs font-medium text-gray-500">{{ cfg.label }}</span>
      </button>
    </div>

    <!-- Search + Filters Bar -->
    <div class="rounded-xl bg-white p-3 md:p-4 shadow-sm ring-1 ring-gray-100 space-y-3">
      <div class="flex flex-wrap gap-2 md:gap-3">
        <div class="relative flex-1 min-w-[180px]">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input v-model="filters.search" @keyup.enter="applyFilters"
            placeholder="Search issue ID, order, description, item..."
            class="w-full rounded-lg border border-gray-200 pl-9 pr-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500" />
        </div>
        <select v-model="filters.status" @change="applyFilters"
          class="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500">
          <option value="">All Status</option>
          <option v-for="(cfg, key) in statusConfig" :key="key" :value="key">{{ cfg.label }}</option>
        </select>
        <button @click="showFilters = !showFilters"
          :class="['flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors',
            hasActiveFilters ? 'border-green-300 bg-green-50 text-green-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50']">
          <Filter class="h-3.5 w-3.5" />
          <span class="hidden sm:inline">Filters</span>
          <span v-if="hasActiveFilters" class="h-1.5 w-1.5 rounded-full bg-green-500" />
        </button>
        <button @click="applyFilters"
          class="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 shadow-sm">Search</button>
        <button v-if="filters.search || filters.status || hasActiveFilters"
          @click="clearFilters"
          class="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-500 hover:bg-gray-50">Clear</button>
      </div>

      <!-- Extended filters -->
      <Transition enter-active-class="transition-all duration-200" enter-from-class="opacity-0 -translate-y-2 max-h-0"
        enter-to-class="opacity-100 translate-y-0 max-h-40"
        leave-active-class="transition-all duration-150" leave-from-class="opacity-100 max-h-40" leave-to-class="opacity-0 max-h-0">
        <div v-if="showFilters" class="flex flex-wrap gap-3 pt-2 border-t border-gray-100">
          <div class="flex flex-col gap-1">
            <label class="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Category</label>
            <select v-model="filters.category" @change="applyFilters"
              class="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500">
              <option value="">All</option>
              <option v-for="cat in categories" :key="cat" :value="cat">{{ cat }} — {{ categoryLabel(cat) }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-[10px] text-gray-400 font-medium uppercase tracking-wide">From</label>
            <input type="date" v-model="filters.date_from" @change="applyFilters"
              class="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500" />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-[10px] text-gray-400 font-medium uppercase tracking-wide">To</label>
            <input type="date" v-model="filters.date_to" @change="applyFilters"
              class="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500" />
          </div>
        </div>
      </Transition>
    </div>

    <!-- Error -->
    <div v-if="err" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-red-700 ring-1 ring-red-200">
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
          <thead class="bg-gray-50 text-xs text-gray-500 uppercase tracking-wider">
            <tr>
              <th class="px-3 md:px-4 py-3 text-left font-medium">Issue ID</th>
              <th class="px-3 md:px-4 py-3 text-left font-medium cursor-pointer select-none"
                @click="toggleSort('order_id')">
                <span class="flex items-center gap-1">Order
                  <ArrowUpDown v-if="sortBy !== 'order_id'" class="h-3 w-3 text-gray-300" />
                  <ChevronUp v-else-if="sortDir === 'ASC'" class="h-3 w-3" />
                  <ChevronDown v-else class="h-3 w-3" />
                </span>
              </th>
              <th class="px-3 md:px-4 py-3 text-left font-medium hidden lg:table-cell cursor-pointer select-none"
                @click="toggleSort('descriptor_code')">
                <span class="flex items-center gap-1">Category
                  <ArrowUpDown v-if="sortBy !== 'descriptor_code'" class="h-3 w-3 text-gray-300" />
                  <ChevronUp v-else-if="sortDir === 'ASC'" class="h-3 w-3" />
                  <ChevronDown v-else class="h-3 w-3" />
                </span>
              </th>
              <th class="px-3 md:px-4 py-3 text-left font-medium hidden md:table-cell">Description</th>
              <th class="px-3 md:px-4 py-3 text-left font-medium hidden xl:table-cell">Item</th>
              <th class="px-3 md:px-4 py-3 text-left font-medium hidden lg:table-cell">Complainant</th>
              <th class="px-3 md:px-4 py-3 text-left font-medium cursor-pointer select-none"
                @click="toggleSort('status')">
                <span class="flex items-center gap-1">Status
                  <ArrowUpDown v-if="sortBy !== 'status'" class="h-3 w-3 text-gray-300" />
                  <ChevronUp v-else-if="sortDir === 'ASC'" class="h-3 w-3" />
                  <ChevronDown v-else class="h-3 w-3" />
                </span>
              </th>
              <th class="px-3 md:px-4 py-3 text-left font-medium cursor-pointer select-none"
                @click="toggleSort('created_at')">
                <span class="flex items-center gap-1">Raised
                  <ArrowUpDown v-if="sortBy !== 'created_at'" class="h-3 w-3 text-gray-300" />
                  <ChevronUp v-else-if="sortDir === 'ASC'" class="h-3 w-3" />
                  <ChevronDown v-else class="h-3 w-3" />
                </span>
              </th>
              <th class="px-3 md:px-4 py-3 text-left font-medium w-8"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            <tr v-for="issue in issues" :key="issue.id"
              class="hover:bg-green-50/30 cursor-pointer transition-colors" @click="openDetail(issue)">
              <td class="px-3 md:px-4 py-3">
                <span class="font-mono text-xs text-gray-600 inline-flex items-center gap-1 group"
                  :title="issue.issue_id">
                  {{ issue.issue_id?.substring(0, 8) }}...
                  <button @click.stop="copyText(issue.issue_id, 'list-' + issue.id)"
                    class="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-gray-600">
                    <Copy class="h-3 w-3" />
                  </button>
                </span>
              </td>
              <td class="px-3 md:px-4 py-3 font-mono text-xs text-gray-600">{{ issue.order_id || '—' }}</td>
              <td class="px-3 md:px-4 py-3 hidden lg:table-cell">
                <span v-if="issue.descriptor_code"
                  class="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-blue-100"
                  :title="categoryLabel(issue.descriptor_code)">
                  {{ issue.descriptor_code }}
                </span>
                <span v-else class="text-gray-400 text-xs">—</span>
              </td>
              <td class="px-3 md:px-4 py-3 max-w-[180px] truncate text-gray-700 text-xs hidden md:table-cell"
                :title="issue.description">
                {{ issue.description || '—' }}
              </td>
              <td class="px-3 md:px-4 py-3 hidden xl:table-cell">
                <span v-if="issue.item_id" class="font-mono text-xs text-gray-500">{{ issue.item_id }}</span>
                <span v-else class="text-gray-400 text-xs">—</span>
              </td>
              <td class="px-3 md:px-4 py-3 text-gray-600 text-xs hidden lg:table-cell">
                {{ issue.complainant_name || '—' }}
              </td>
              <td class="px-3 md:px-4 py-3">
                <span :class="['inline-flex items-center gap-1 w-fit rounded-full px-2 py-0.5 text-[11px] font-medium ring-1',
                  statusConfig[issue.status]?.color || 'bg-gray-100 text-gray-600 ring-gray-200']">
                  <span class="h-1.5 w-1.5 rounded-full" :class="statusConfig[issue.status]?.dot || 'bg-gray-400'" />
                  {{ statusConfig[issue.status]?.label || issue.status }}
                </span>
              </td>
              <td class="px-3 md:px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{{ formatDate(issue.created_at) }}</td>
              <td class="px-3 md:px-4 py-3">
                <ChevronRight class="h-4 w-4 text-gray-300" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div v-if="total > 0" class="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-sm text-gray-500">
        <span class="text-xs">{{ total }} issue{{ total !== 1 ? 's' : '' }}</span>
        <div class="flex items-center gap-2">
          <button @click="page = Math.max(1, page - 1); fetchIssues()" :disabled="page <= 1"
            class="rounded border border-gray-200 px-2.5 py-1 text-xs hover:bg-gray-50 disabled:opacity-40">Prev</button>
          <span class="text-xs px-1">{{ page }} / {{ totalPages }}</span>
          <button @click="page++; fetchIssues()" :disabled="page >= totalPages"
            class="rounded border border-gray-200 px-2.5 py-1 text-xs hover:bg-gray-50 disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    <!-- DETAIL SLIDE-OVER PANEL                                                -->
    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <Transition enter-active-class="transition-opacity duration-200" enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
        <div v-if="showDetail" class="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-[2px]" @click.self="closeDetail">
          <Transition enter-active-class="transition-transform duration-300 ease-out" enter-from-class="translate-x-full"
            enter-to-class="translate-x-0" leave-active-class="transition-transform duration-200 ease-in"
            leave-from-class="translate-x-0" leave-to-class="translate-x-full">
            <div v-if="showDetail" class="w-full max-w-2xl bg-white shadow-2xl overflow-y-auto">
              <!-- Panel header -->
              <div class="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white/95 backdrop-blur px-5 md:px-6 py-4">
                <h2 class="font-semibold text-gray-900 flex items-center gap-2">
                  <Shield class="h-4 w-4 text-green-600" />
                  Complaint Detail
                </h2>
                <button @click="closeDetail" class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
                  <X class="h-5 w-5" />
                </button>
              </div>

              <!-- Loading -->
              <div v-if="detailLoading" class="p-6 space-y-4">
                <div v-for="i in 6" :key="i" class="h-12 animate-pulse rounded-xl bg-gray-100" />
              </div>

              <!-- Content -->
              <div v-else-if="detail" class="p-5 md:p-6 space-y-5">

                <!-- ═══ 1. COMPLAINT HEADER ═══════════════════════════════════ -->
                <div class="rounded-xl bg-gray-50 p-4 md:p-5 space-y-3 ring-1 ring-gray-100">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Issue ID</div>
                      <div class="font-mono text-sm text-gray-800 flex items-center gap-1.5 group">
                        <span class="truncate select-all">{{ detail.issue_id }}</span>
                        <button @click="copyText(detail.issue_id, 'issue-id')"
                          class="opacity-0 group-hover:opacity-100 shrink-0 text-gray-400 hover:text-gray-600 transition-opacity">
                          <Copy class="h-3.5 w-3.5" />
                        </button>
                        <span v-if="copiedField === 'issue-id'" class="text-[10px] text-green-600 shrink-0">Copied</span>
                      </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <span v-if="detail.parsed?.isV2" class="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600 font-semibold ring-1 ring-indigo-100">IGM v2.0</span>
                      <span v-else-if="detail.parsed?.isV2 === false" class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 font-semibold">IGM v1.0</span>
                      <span :class="['flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1',
                        statusConfig[detail.status]?.color || 'bg-gray-100 text-gray-600 ring-gray-200']">
                        <span class="h-1.5 w-1.5 rounded-full" :class="statusConfig[detail.status]?.dot || 'bg-gray-400'" />
                        {{ statusConfig[detail.status]?.label || detail.status }}
                      </span>
                    </div>
                  </div>

                  <div class="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                    <div>
                      <span class="text-[10px] text-gray-400 uppercase tracking-wide">Category</span>
                      <div class="text-gray-800 font-medium flex items-center gap-1.5 mt-0.5">
                        <span v-if="detail.parsed?.descriptorCode || detail.descriptor_code"
                          class="rounded bg-blue-50 px-1.5 py-0.5 text-xs font-mono text-blue-700 ring-1 ring-blue-100">
                          {{ detail.parsed?.descriptorCode || detail.descriptor_code }}
                        </span>
                        <span class="text-xs text-gray-500">{{ categoryLabel(detail.parsed?.descriptorCode || detail.descriptor_code) }}</span>
                      </div>
                    </div>
                    <div>
                      <span class="text-[10px] text-gray-400 uppercase tracking-wide">Order ID</span>
                      <div class="flex items-center gap-1.5 mt-0.5">
                        <span class="font-mono text-gray-800 text-sm">{{ detail.parsed?.orderId || detail.order_id || '—' }}</span>
                        <button v-if="detail.linkedOrder" @click="goToOrder(detail.linkedOrder.id)"
                          class="text-green-600 hover:text-green-700" title="View order">
                          <ExternalLink class="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <div>
                      <span class="text-[10px] text-gray-400 uppercase tracking-wide">Transaction ID</span>
                      <div class="font-mono text-xs text-gray-600 truncate group flex items-center gap-1 mt-0.5" :title="detail.transaction_id">
                        {{ detail.transaction_id || '—' }}
                        <button v-if="detail.transaction_id" @click="copyText(detail.transaction_id, 'txn-id')"
                          class="opacity-0 group-hover:opacity-100 shrink-0 text-gray-400 hover:text-gray-600">
                          <Copy class="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    <div>
                      <span class="text-[10px] text-gray-400 uppercase tracking-wide">Type</span>
                      <div class="text-gray-700 text-sm mt-0.5">
                        {{ detail.parsed?.issueType || detail.issue_type || 'ISSUE' }}
                      </div>
                    </div>
                  </div>

                  <!-- Description -->
                  <div class="border-t border-gray-200 pt-2.5">
                    <span class="text-[10px] text-gray-400 uppercase tracking-wide">Description</span>
                    <div class="text-gray-700 text-sm mt-0.5">{{ detail.parsed?.shortDesc || detail.description || '—' }}</div>
                    <div v-if="detail.parsed?.longDesc && detail.parsed?.longDesc !== detail.parsed?.shortDesc"
                      class="text-xs text-gray-500 mt-1 italic">{{ detail.parsed.longDesc }}</div>
                  </div>

                  <!-- References -->
                  <div v-if="detail.parsed?.providerId || detail.parsed?.itemId || detail.parsed?.fulfillmentId"
                    class="flex flex-wrap gap-1.5 border-t border-gray-200 pt-2.5">
                    <span v-if="detail.parsed?.providerId"
                      class="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-[11px] text-gray-600">
                      <Building class="h-3 w-3 text-gray-400" /> Provider: <strong class="font-mono">{{ detail.parsed.providerId }}</strong>
                    </span>
                    <span v-if="detail.parsed?.itemId"
                      class="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-[11px] text-gray-600">
                      <Package class="h-3 w-3 text-gray-400" /> Item: <strong class="font-mono">{{ detail.parsed.itemId }}</strong>
                    </span>
                    <span v-if="detail.parsed?.fulfillmentId"
                      class="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-[11px] text-gray-600">
                      <Hash class="h-3 w-3 text-gray-400" /> Fulfillment: <strong class="font-mono">{{ detail.parsed.fulfillmentId }}</strong>
                    </span>
                  </div>

                  <!-- Timestamps -->
                  <div class="grid grid-cols-3 gap-3 text-xs border-t border-gray-200 pt-2.5">
                    <div>
                      <span class="text-[10px] text-gray-400 uppercase tracking-wide">Raised</span>
                      <div class="text-gray-600 mt-0.5">{{ formatFullDate(detail.parsed?.createdAt || detail.created_at) }}</div>
                    </div>
                    <div>
                      <span class="text-[10px] text-gray-400 uppercase tracking-wide">Resolved</span>
                      <div class="text-gray-600 mt-0.5">{{ formatFullDate(detail.parsed?.resolvedAt || detail.resolved_at) }}</div>
                    </div>
                    <div>
                      <span class="text-[10px] text-gray-400 uppercase tracking-wide">Closed</span>
                      <div class="text-gray-600 mt-0.5">{{ formatFullDate(detail.parsed?.closedAt || detail.closed_at) }}</div>
                    </div>
                  </div>
                </div>

                <!-- ═══ Linked Order ══════════════════════════════════════════ -->
                <div v-if="detail.linkedOrder" class="rounded-xl bg-blue-50/50 p-4 ring-1 ring-blue-100">
                  <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2">
                      <Package class="h-4 w-4 text-blue-600" />
                      <span class="text-sm font-semibold text-blue-800">Linked Order</span>
                    </div>
                    <button @click="goToOrder(detail.linkedOrder.id)"
                      class="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium">
                      View <ExternalLink class="h-3 w-3" />
                    </button>
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
                      <div class="text-blue-800 font-medium">₹{{ detail.linkedOrder.total_amount }}</div>
                    </div>
                  </div>
                </div>

                <!-- ═══ 2. PARTIES ════════════════════════════════════════════ -->
                <div v-if="detail.parsed?.actors?.length" class="rounded-xl bg-white p-4 ring-1 ring-gray-100">
                  <div class="flex items-center gap-2 mb-3">
                    <User class="h-4 w-4 text-gray-500" />
                    <span class="text-sm font-semibold text-gray-700">Parties</span>
                    <span class="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 font-medium">{{ detail.parsed.actors.length }}</span>
                  </div>
                  <div class="grid grid-cols-1 gap-2">
                    <div v-for="actor in detail.parsed.actors" :key="actor.id"
                      :class="['rounded-lg p-3 ring-1',
                        actor.type === 'INTERFACING_NP' ? 'bg-orange-50/40 ring-orange-100' :
                        actor.type === 'COUNTERPARTY_NP' ? 'bg-green-50/40 ring-green-100' :
                        actor.type?.includes('GRO') ? 'bg-indigo-50/40 ring-indigo-100' :
                        'bg-gray-50/40 ring-gray-100']">
                      <div class="flex items-center justify-between">
                        <div>
                          <div class="text-sm font-medium text-gray-800">{{ actor.personName || actor.orgName || '—' }}</div>
                          <div v-if="actor.orgName && actor.personName" class="text-[11px] text-gray-500 mt-0.5">
                            <Building class="inline h-3 w-3 -mt-0.5 text-gray-400" /> {{ actor.orgName }}
                          </div>
                        </div>
                        <span :class="['rounded px-1.5 py-0.5 text-[10px] font-medium',
                          actor.type === 'INTERFACING_NP' ? 'bg-orange-100 text-orange-700' :
                          actor.type === 'COUNTERPARTY_NP' ? 'bg-green-100 text-green-700' :
                          actor.type?.includes('GRO') ? 'bg-indigo-100 text-indigo-700' :
                          'bg-gray-100 text-gray-600']">
                          {{ actor.roleLabel || actor.type }}
                        </span>
                      </div>
                      <div v-if="actor.phone || actor.email" class="flex items-center gap-3 mt-1.5 text-[11px] text-gray-500">
                        <span v-if="actor.phone">{{ actor.phone }}</span>
                        <span v-if="actor.email">{{ actor.email }}</span>
                      </div>
                      <div class="font-mono text-[10px] text-gray-400 mt-1 truncate" :title="actor.id">{{ actor.id }}</div>
                    </div>
                  </div>
                </div>

                <!-- ═══ 3. ACTION TIMELINE ════════════════════════════════════ -->
                <div v-if="detail.parsed?.actions?.length" class="rounded-xl bg-white p-4 ring-1 ring-gray-100">
                  <div class="flex items-center gap-2 mb-4">
                    <Zap class="h-4 w-4 text-indigo-500" />
                    <span class="text-sm font-semibold text-gray-700">Action Timeline</span>
                    <span class="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] text-indigo-600 font-medium">
                      {{ detail.parsed.actions.length }} actions
                    </span>
                  </div>
                  <div class="relative pl-6 space-y-0">
                    <div class="absolute left-[11px] top-2 bottom-2 w-px bg-gray-200" />

                    <div v-for="(act, idx) in detail.parsed.actions" :key="idx"
                      class="relative pb-3 last:pb-0">
                      <!-- Elapsed badge between actions -->
                      <div v-if="act.elapsedMs && act.elapsedMs > 0"
                        class="absolute -left-[22px] -top-1.5 text-[9px] text-gray-400 bg-white px-0.5 z-10 whitespace-nowrap">
                        +{{ formatElapsed(act.elapsedMs) }}
                      </div>
                      <!-- Dot -->
                      <div :class="['absolute -left-[13px] top-1.5 h-3 w-3 rounded-full border-2 border-white shadow-sm', actionDot(act.code)]" />

                      <!-- Action card -->
                      <div :class="['rounded-lg border px-3 py-2', actionClass(act.code)]">
                        <div class="flex items-center justify-between gap-2">
                          <span class="text-xs font-bold">{{ act.code }}</span>
                          <span class="text-[10px] text-gray-400 whitespace-nowrap">{{ formatFullDate(act.updated_at) }}</span>
                        </div>
                        <div v-if="act.short_desc && act.short_desc !== act.code"
                          class="text-[11px] mt-0.5 opacity-80">{{ act.short_desc }}</div>
                        <div class="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span v-if="act.actorName" class="text-[10px] opacity-70">
                            by <strong>{{ act.actorName }}</strong>
                            <span v-if="act.actorRole" class="opacity-60"> ({{ act.actorRole }})</span>
                          </span>
                          <span v-else-if="act.action_by" class="text-[10px] opacity-60 truncate max-w-[180px]" :title="act.action_by">
                            by {{ act.action_by }}
                          </span>
                          <span v-if="act.ref_id" class="text-[10px] opacity-50 font-mono flex items-center gap-0.5">
                            <Link class="h-2.5 w-2.5" /> {{ act.ref_id }}
                          </span>
                        </div>
                        <!-- Attachments -->
                        <div v-if="act.attachments" class="flex flex-wrap gap-1.5 mt-1.5">
                          <a v-for="(att, ai) in act.attachments" :key="ai"
                            :href="att.url" target="_blank" rel="noopener noreferrer"
                            class="inline-flex items-center gap-1 rounded bg-white/60 px-1.5 py-0.5 text-[10px] text-blue-600 ring-1 ring-blue-200 hover:bg-blue-50">
                            <Paperclip class="h-2.5 w-2.5" /> {{ att.mimetype || 'attachment' }}
                          </a>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- ═══ 4. FINAL RESOLUTION ═══════════════════════════════════ -->
                <div v-if="detail.parsed?.finalResolution || detail.parsed?.resolutions?.length"
                  class="rounded-xl bg-white p-4 ring-1 ring-gray-100 space-y-3">

                  <!-- Final outcome (prominent) -->
                  <div v-if="detail.parsed?.finalResolution" class="rounded-lg bg-green-50 p-3 ring-1 ring-green-200">
                    <div class="flex items-center gap-2 mb-1.5">
                      <Award class="h-4 w-4 text-green-600" />
                      <span class="text-sm font-semibold text-green-800">Final Resolution</span>
                    </div>
                    <div class="flex items-center gap-2">
                      <span class="rounded-full bg-green-100 px-3 py-1 text-sm font-bold text-green-800 ring-1 ring-green-300">
                        {{ detail.parsed.finalResolution.code }}
                      </span>
                      <span class="text-xs text-green-700">{{ detail.parsed.finalResolution.short_desc }}</span>
                    </div>
                    <!-- Show refund only if REFUND was the accepted resolution -->
                    <div v-if="detail.parsed.refundDetails?.isAccepted"
                      class="mt-2 pt-2 border-t border-green-200 text-xs">
                      <span class="text-green-700 font-medium">Refund issued:</span>
                      <span class="text-green-800 font-bold ml-1">₹{{ detail.parsed.refundDetails.amount }}</span>
                      <span v-if="detail.parsed.refundDetails.item" class="text-green-600 ml-2">for item {{ detail.parsed.refundDetails.item }}</span>
                    </div>
                  </div>

                  <!-- Resolution warning -->
                  <div v-if="detail.parsed?.resolutionWarning"
                    class="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 ring-1 ring-amber-200 text-xs text-amber-700">
                    <AlertTriangle class="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{{ detail.parsed.resolutionWarning }}</span>
                  </div>

                  <!-- Proposed options -->
                  <div v-if="detail.parsed?.resolutions?.filter(r => r.code !== 'PARENT').length">
                    <div class="flex items-center gap-2 mb-2">
                      <FileText class="h-4 w-4 text-gray-400" />
                      <span class="text-sm font-medium text-gray-600">Proposed Options</span>
                    </div>
                    <div class="space-y-1.5">
                      <div v-for="res in detail.parsed.resolutions.filter(r => r.code !== 'PARENT')" :key="res.id"
                        :class="['rounded-lg border px-3 py-2 text-sm',
                          detail.parsed.finalResolution?.id === res.id
                            ? 'border-green-300 bg-green-50/50'
                            : 'border-gray-200 bg-gray-50/50']">
                        <div class="flex items-center justify-between">
                          <span class="font-medium text-gray-700 text-xs">{{ res.code }}</span>
                          <span v-if="detail.parsed.finalResolution?.id === res.id"
                            class="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
                            <CheckCircle class="h-3 w-3" /> Selected
                          </span>
                          <span v-else class="text-[10px] text-gray-400 italic">Proposed</span>
                        </div>
                        <div class="text-[11px] text-gray-500 mt-0.5">{{ res.short_desc }}</div>
                        <!-- Proposed refund amount (not issued if NO-ACTION was selected) -->
                        <div v-if="res.code === 'REFUND' && detail.parsed.refundDetails && !detail.parsed.refundDetails.isAccepted"
                          class="text-[11px] text-gray-400 mt-1 italic">
                          Proposed ₹{{ detail.parsed.refundDetails.amount }} (not issued)
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- ═══ 5. CLOSURE FEEDBACK ═══════════════════════════════════ -->
                <div v-if="detail.parsed?.closureFeedback" class="rounded-xl bg-white p-4 ring-1 ring-gray-100">
                  <div class="flex items-center gap-2 mb-2">
                    <component :is="detail.parsed.closureFeedback.rating === 'THUMBS_UP' ? ThumbsUp : ThumbsDown"
                      :class="['h-4 w-4', detail.parsed.closureFeedback.rating === 'THUMBS_UP' ? 'text-green-500' : 'text-red-500']" />
                    <span class="text-sm font-semibold text-gray-700">Closure Feedback</span>
                  </div>
                  <div class="flex items-center gap-2 flex-wrap">
                    <span :class="['rounded-full px-2.5 py-1 text-xs font-medium ring-1',
                      detail.parsed.closureFeedback.rating === 'THUMBS_UP'
                        ? 'bg-green-50 text-green-700 ring-green-200'
                        : 'bg-red-50 text-red-700 ring-red-200']">
                      {{ detail.parsed.closureFeedback.rating }}
                    </span>
                    <span v-if="detail.parsed.closureFeedback.remarks" class="text-xs text-gray-500">
                      {{ detail.parsed.closureFeedback.remarks }}
                    </span>
                  </div>
                  <div class="text-[11px] text-gray-400 mt-2 flex items-center gap-3">
                    <span v-if="detail.parsed.closureFeedback.closedByName">
                      Closed by <strong>{{ detail.parsed.closureFeedback.closedByName }}</strong>
                    </span>
                    <span v-if="detail.parsed.closureFeedback.closedAt">
                      {{ formatFullDate(detail.parsed.closureFeedback.closedAt) }}
                    </span>
                  </div>
                </div>

                <!-- ═══ 6. PROTOCOL LOG ═══════════════════════════════════════ -->
                <div v-if="detail.protocolTimeline?.length" class="rounded-xl bg-white p-4 ring-1 ring-gray-100">
                  <div class="flex items-center justify-between mb-3">
                    <div class="flex items-center gap-2">
                      <MessageSquare class="h-4 w-4 text-gray-500" />
                      <span class="text-sm font-semibold text-gray-700">Protocol Log</span>
                    </div>
                    <div class="flex items-center gap-2">
                      <div class="flex rounded-lg bg-gray-100 p-0.5 text-[10px]">
                        <button @click="protocolFilter = 'igm'"
                          :class="['rounded-md px-2 py-0.5 font-medium transition-colors',
                            protocolFilter === 'igm' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700']">
                          IGM Only
                        </button>
                        <button @click="protocolFilter = 'all'"
                          :class="['rounded-md px-2 py-0.5 font-medium transition-colors',
                            protocolFilter === 'all' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700']">
                          All Events
                        </button>
                      </div>
                      <button v-if="detail.transaction_id" @click="goToWorkflow(detail.transaction_id)"
                        class="flex items-center gap-1 text-xs text-green-600 hover:text-green-700 font-medium">
                        <ExternalLink class="h-3 w-3" />
                      </button>
                    </div>
                  </div>

                  <div class="space-y-0.5 max-h-64 overflow-y-auto pr-1">
                    <div v-for="t in filteredProtocol" :key="t.id"
                      :class="['flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors',
                        t.is_igm ? 'hover:bg-gray-50' : 'hover:bg-gray-50 opacity-60']">
                      <span :class="[
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded',
                        t.direction === 'inbound'
                          ? 'bg-blue-100 text-blue-600'
                          : 'bg-green-100 text-green-600'
                      ]">
                        <component :is="t.direction === 'inbound' ? ArrowDownLeft : ArrowUpRight" class="h-2.5 w-2.5" />
                      </span>
                      <span :class="['font-mono font-bold w-24 shrink-0', t.is_igm ? 'text-gray-700' : 'text-gray-500']">{{ t.action }}</span>
                      <span v-if="t.issue_status" :class="['rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1',
                        statusConfig[t.issue_status?.toLowerCase()]?.color || 'bg-gray-100 text-gray-600 ring-gray-200']">
                        {{ t.issue_status }}
                      </span>
                      <span v-if="t.ack_status" :class="['text-[9px] font-medium',
                        t.ack_status === 'ACK' ? 'text-green-600' : t.ack_status === 'NACK' ? 'text-red-600' : 'text-gray-400']">
                        {{ t.ack_status }}
                      </span>
                      <span class="ml-auto text-gray-400 whitespace-nowrap font-mono text-[10px]">{{ formatTime(t.created_at) }}</span>
                    </div>
                  </div>
                  <div class="text-[10px] text-gray-400 mt-2 text-right">
                    {{ filteredProtocol.length }} of {{ detail.protocolTimeline.length }} events
                  </div>
                </div>

                <!-- ═══ 7. RAW PAYLOAD ════════════════════════════════════════ -->
                <div v-if="detail.has_raw_payload" class="rounded-xl bg-white ring-1 ring-gray-100 overflow-hidden">
                  <button @click="toggleRaw"
                    class="flex items-center justify-between w-full px-4 py-3 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                    <span class="flex items-center gap-2">
                      <Eye class="h-4 w-4 text-gray-400" />
                      Raw ONDC Payload
                    </span>
                    <div class="flex items-center gap-2">
                      <span v-if="rawLoading" class="text-[10px] text-gray-400 animate-pulse">Loading...</span>
                      <component :is="showRaw ? ChevronUp : ChevronDown" class="h-4 w-4 text-gray-400" />
                    </div>
                  </button>
                  <Transition enter-active-class="transition-all duration-200" enter-from-class="opacity-0 max-h-0"
                    enter-to-class="opacity-100 max-h-[500px]"
                    leave-active-class="transition-all duration-150" leave-from-class="opacity-100 max-h-[500px]" leave-to-class="opacity-0 max-h-0">
                    <div v-if="showRaw && rawPayload" class="border-t border-gray-100 relative">
                      <button @click="copyText(prettyJson(rawPayload), 'raw-json')"
                        class="absolute top-2 right-2 z-10 rounded bg-gray-800/80 p-1.5 text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
                        title="Copy JSON">
                        <Copy class="h-3.5 w-3.5" />
                      </button>
                      <span v-if="copiedField === 'raw-json'" class="absolute top-2.5 right-10 z-10 text-[10px] text-green-400 bg-gray-800/80 rounded px-1.5 py-0.5">
                        Copied!
                      </span>
                      <pre class="p-4 text-[11px] font-mono whitespace-pre-wrap break-all max-h-80 overflow-y-auto bg-gray-900 text-green-300 select-text">{{ prettyJson(rawPayload) }}</pre>
                    </div>
                  </Transition>
                </div>

              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
