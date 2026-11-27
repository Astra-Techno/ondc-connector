<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { get, put } from '@/utils/api'
import { useToast } from '@/stores/toast'
import { ShoppingCart, AlertCircle, ChevronLeft, ChevronRight, RefreshCw, X, Truck, Package } from 'lucide-vue-next'

const router = useRouter()
const toast  = useToast()

const loading = ref(true)
const error   = ref(null)
const orders  = ref([])
const total   = ref(0)
const revenue = ref(0)
const statusFilter = ref('')
const fulfillmentFilter = ref('')
const dateFrom     = ref('')
const dateTo       = ref('')
const page    = ref(1)
const perPage = 50
let timer = null

// Order detail modal
const showDetail  = ref(false)
const selected    = ref(null)
const updatingStatus = ref(false)
const newStatus   = ref('')

// Timeline & logs for modal
const timeline    = ref([])
const protocolLogs = ref([])
const showLogs    = ref(false)
const loadingTimeline = ref(false)
const expandedLog = ref(null)

const statusOptions = [
  { value: '',          label: 'All Status' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'packed',    label: 'Packed' },
  { value: 'shipped',   label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
]

const fulfillmentOptions = [
  { value: '',               label: 'All Fulfillment' },
  { value: 'Delivery',       label: 'Delivery' },
  { value: 'Buyer-Delivery', label: 'Buyer-Delivery' },
]

const updateStatuses = ['confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned']

const statusBadge = {
  confirmed: 'bg-blue-100 text-blue-700',
  packed:    'bg-yellow-100 text-yellow-700',
  shipped:   'bg-orange-100 text-orange-700',
  delivered: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
  returned:  'bg-purple-100 text-purple-700',
}

const fulfillmentBadge = {
  'Delivery':       'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200',
  'Buyer-Delivery': 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
}

const fulfillmentStateBadge = {
  'Created':           'bg-gray-100 text-gray-600',
  'Accepted':          'bg-blue-50 text-blue-600',
  'Packed':            'bg-yellow-50 text-yellow-700',
  'Order-picked-up':   'bg-orange-50 text-orange-700',
  'Out-for-delivery':  'bg-orange-100 text-orange-700',
  'Order-delivered':   'bg-green-50 text-green-700',
  'Cancelled':         'bg-red-50 text-red-600',
  'RTO-Initiated':     'bg-red-50 text-red-600',
  'RTO-Delivered':     'bg-red-100 text-red-700',
  'Return_Initiated':  'bg-purple-50 text-purple-600',
  'Return_Approved':   'bg-purple-50 text-purple-700',
  'Return_Picked':     'bg-purple-100 text-purple-700',
  'Return_Delivered':  'bg-purple-100 text-purple-800',
}

const totalPages = computed(() => Math.ceil(total.value / perPage))

async function fetchOrders() {
  loading.value = true
  error.value   = null
  const { data, error: err } = await get('/orders', {
    status:           statusFilter.value      || undefined,
    fulfillment_type: fulfillmentFilter.value  || undefined,
    from:             dateFrom.value           || undefined,
    to:               dateTo.value             || undefined,
    page:             page.value,
    limit:            perPage,
  })
  if (err) { error.value = err }
  else {
    orders.value  = data?.orders  || []
    total.value   = data?.total   || 0
    revenue.value = data?.revenue || 0
  }
  loading.value = false
}

async function openDetail(order) {
  selected.value  = order
  newStatus.value = order.status
  showDetail.value = true
  showLogs.value = false
  expandedLog.value = null
  timeline.value = []
  protocolLogs.value = []

  // Fetch timeline
  if (order.ondc_order_id) {
    loadingTimeline.value = true
    const { data } = await get(`/orders/${order.ondc_order_id}/timeline`)
    timeline.value = data || []
    loadingTimeline.value = false
  }
}

async function fetchLogs() {
  if (!selected.value?.ondc_order_id) return
  if (protocolLogs.value.length) { showLogs.value = !showLogs.value; return }
  const { data } = await get(`/orders/${selected.value.ondc_order_id}/logs`)
  protocolLogs.value = data || []
  showLogs.value = true
}

function toggleLog(id) {
  expandedLog.value = expandedLog.value === id ? null : id
}

function closeDetail() {
  showDetail.value = false
  selected.value   = null
}

async function saveStatus() {
  if (!selected.value || newStatus.value === selected.value.status) return
  updatingStatus.value = true
  const { error: err } = await put(`/orders/${selected.value.ondc_order_id}/status`, { status: newStatus.value })
  if (err) { toast.error(err) }
  else {
    toast.success('Order status updated')
    selected.value.status = newStatus.value
    fetchOrders()
    closeDetail()
  }
  updatingStatus.value = false
}

function getItems(order) {
  try { return JSON.parse(order.items || '[]') } catch { return [] }
}

function getAddress(order) {
  try { return JSON.parse(order.delivery_address || '{}') } catch { return {} }
}

function formatCurrency(v) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function onFilter() { page.value = 1; fetchOrders() }

onMounted(() => {
  fetchOrders()
  timer = setInterval(fetchOrders, 60000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="p-6 space-y-5">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-gray-900">Orders</h1>
        <span class="rounded-full bg-gray-100 px-2.5 py-0.5 text-sm font-medium text-gray-600">{{ total }}</span>
      </div>
      <button @click="fetchOrders" :disabled="loading"
        class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
        <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <!-- Revenue summary -->
    <div v-if="!loading" class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100 text-sm text-gray-600">
      Total Revenue: <span class="ml-2 text-lg font-bold text-gray-900">{{ formatCurrency(revenue) }}</span>
    </div>

    <!-- Filters -->
    <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
      <select v-model="statusFilter" @change="onFilter"
        class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500">
        <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <select v-model="fulfillmentFilter" @change="onFilter"
        class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500">
        <option v-for="opt in fulfillmentOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <input v-model="dateFrom" @change="onFilter" type="date"
        class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500" />
      <input v-model="dateTo" @change="onFilter" type="date"
        class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500" />
    </div>

    <div v-if="error" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-sm text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ error }}
    </div>

    <div class="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-100">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th class="px-4 py-3 text-left font-medium">ONDC Order ID</th>
              <th class="px-4 py-3 text-left font-medium">Buyer</th>
              <th class="px-4 py-3 text-left font-medium">Items</th>
              <th class="px-4 py-3 text-right font-medium">Amount</th>
              <th class="px-4 py-3 text-left font-medium">Order Status</th>
              <th class="px-4 py-3 text-left font-medium">Fulfillment</th>
              <th class="px-4 py-3 text-left font-medium">Type</th>
              <th class="px-4 py-3 text-left font-medium">Date</th>
              <th class="px-4 py-3 text-left font-medium">Action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            <template v-if="loading">
              <tr v-for="i in 8" :key="i">
                <td v-for="j in 9" :key="j" class="px-4 py-3">
                  <div class="h-4 w-20 animate-pulse rounded bg-gray-100" />
                </td>
              </tr>
            </template>
            <template v-else-if="orders.length">
              <tr v-for="o in orders" :key="o.id" class="hover:bg-gray-50/50 cursor-pointer" @click="openDetail(o)">
                <td class="px-4 py-3 font-mono text-xs text-gray-500 max-w-[120px] truncate" :title="o.ondc_order_id">
                  {{ o.ondc_order_id || '—' }}
                </td>
                <td class="px-4 py-3">
                  <div class="font-medium text-gray-900">{{ o.buyer_name || '—' }}</div>
                  <div class="text-xs text-gray-400">{{ o.buyer_phone || '' }}</div>
                </td>
                <td class="px-4 py-3 text-gray-600">
                  {{ getItems(o).length }} item{{ getItems(o).length !== 1 ? 's' : '' }}
                </td>
                <td class="px-4 py-3 text-right font-semibold text-gray-900">{{ formatCurrency(o.total_amount) }}</td>
                <td class="px-4 py-3">
                  <span :class="['rounded-full px-2 py-0.5 text-xs font-medium capitalize', statusBadge[o.status] || 'bg-gray-100 text-gray-500']">
                    {{ o.status }}
                  </span>
                </td>
                <td class="px-4 py-3">
                  <span v-if="o.fulfillment_status"
                    :class="['rounded-full px-2 py-0.5 text-xs font-medium', fulfillmentStateBadge[o.fulfillment_status] || 'bg-gray-100 text-gray-500']">
                    {{ o.fulfillment_status }}
                  </span>
                  <span v-else class="text-xs text-gray-400">—</span>
                </td>
                <td class="px-4 py-3">
                  <span :class="['inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', fulfillmentBadge[o.fulfillment_type] || 'bg-gray-100 text-gray-500']">
                    <Truck v-if="o.fulfillment_type === 'Delivery'" class="h-3 w-3" />
                    <Package v-else class="h-3 w-3" />
                    {{ o.fulfillment_type === 'Buyer-Delivery' ? 'BD' : 'Del' }}
                  </span>
                </td>
                <td class="px-4 py-3 text-gray-500 whitespace-nowrap">{{ formatDate(o.created_at) }}</td>
                <td class="px-4 py-3">
                  <button @click.stop="openDetail(o)"
                    class="rounded-lg border border-gray-200 px-3 py-1 text-xs text-gray-600 hover:border-green-400 hover:text-green-600">
                    Details
                  </button>
                </td>
              </tr>
            </template>
            <tr v-else>
              <td colspan="9" class="px-5 py-16 text-center">
                <ShoppingCart class="mx-auto mb-3 h-10 w-10 text-gray-200" />
                <p class="text-sm text-gray-400">No orders found</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="totalPages > 1" class="flex items-center justify-between border-t border-gray-100 px-5 py-3 text-sm text-gray-600">
        <span>Page {{ page }} of {{ totalPages }}</span>
        <div class="flex gap-1">
          <button @click="page--; fetchOrders()" :disabled="page === 1" class="rounded p-1 hover:bg-gray-100 disabled:opacity-40">
            <ChevronLeft class="h-4 w-4" />
          </button>
          <button @click="page++; fetchOrders()" :disabled="page === totalPages" class="rounded p-1 hover:bg-gray-100 disabled:opacity-40">
            <ChevronRight class="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>

    <!-- Order Detail Modal -->
    <Teleport to="body">
      <Transition enter-active-class="transition-opacity duration-200" enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
        <div v-if="showDetail" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="closeDetail">
          <div class="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-2xl">
            <!-- Modal header -->
            <div class="sticky top-0 flex items-center justify-between border-b border-gray-100 bg-white px-6 py-4 z-10">
              <div class="flex items-center gap-3">
                <h2 class="font-semibold text-gray-900">Order Details</h2>
                <span v-if="selected" :class="['rounded-full px-2 py-0.5 text-xs font-medium', fulfillmentBadge[selected.fulfillment_type] || '']">
                  {{ selected.fulfillment_type || 'Delivery' }}
                </span>
              </div>
              <button @click="closeDetail" class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
                <X class="h-4 w-4" />
              </button>
            </div>

            <div v-if="selected" class="p-6 space-y-5">
              <!-- IDs -->
              <div class="grid grid-cols-2 gap-4 text-sm">
                <div class="space-y-1 rounded-lg bg-gray-50 p-3">
                  <p class="text-xs text-gray-500">ONDC Order ID</p>
                  <p class="font-mono text-xs font-medium text-gray-800 break-all">{{ selected.ondc_order_id || '—' }}</p>
                </div>
                <div class="space-y-1 rounded-lg bg-gray-50 p-3">
                  <p class="text-xs text-gray-500">Transaction ID</p>
                  <p class="font-mono text-xs text-gray-600 break-all">{{ selected.ondc_transaction_id || '—' }}</p>
                </div>
                <div class="space-y-1 rounded-lg bg-gray-50 p-3">
                  <p class="text-xs text-gray-500">BAP ID</p>
                  <p class="font-mono text-xs text-gray-600">{{ selected.bap_id || '—' }}</p>
                </div>
                <div class="space-y-1 rounded-lg bg-gray-50 p-3">
                  <p class="text-xs text-gray-500">CottKart Order ID</p>
                  <p class="font-mono text-xs font-medium text-gray-800">{{ selected.cottkart_order_id || '—' }}</p>
                </div>
              </div>

              <!-- Order + Fulfillment Status -->
              <div class="flex items-center gap-4">
                <div>
                  <p class="text-xs text-gray-500 mb-1">Order Status</p>
                  <span :class="['rounded-full px-3 py-1 text-sm font-semibold capitalize', statusBadge[selected.status] || 'bg-gray-100 text-gray-600']">
                    {{ selected.status }}
                  </span>
                </div>
                <div v-if="selected.fulfillment_status">
                  <p class="text-xs text-gray-500 mb-1">Fulfillment Status</p>
                  <span :class="['rounded-full px-3 py-1 text-sm font-semibold', fulfillmentStateBadge[selected.fulfillment_status] || 'bg-gray-100 text-gray-600']">
                    {{ selected.fulfillment_status }}
                  </span>
                </div>
              </div>

              <!-- Fulfillment Timeline -->
              <div>
                <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Fulfillment Timeline</h3>
                <div v-if="loadingTimeline" class="flex items-center gap-2 text-sm text-gray-400">
                  <RefreshCw class="h-4 w-4 animate-spin" /> Loading timeline...
                </div>
                <div v-else-if="timeline.length" class="relative ml-3 border-l-2 border-gray-200 pl-5 space-y-3">
                  <div v-for="(evt, idx) in timeline" :key="idx" class="relative">
                    <div class="absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-white"
                      :class="evt.direction === 'outbound' ? 'bg-green-500' : 'bg-blue-500'"></div>
                    <div class="flex items-baseline gap-2">
                      <span class="font-mono text-xs font-semibold" :class="evt.direction === 'outbound' ? 'text-green-700' : 'text-blue-700'">
                        {{ evt.action }}
                      </span>
                      <span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{{ evt.direction }}</span>
                      <span v-if="evt.fulfillment_state" class="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600">
                        {{ evt.fulfillment_state }}
                      </span>
                    </div>
                    <p class="text-[11px] text-gray-400 mt-0.5">{{ formatDateTime(evt.timestamp) }}</p>
                  </div>
                </div>
                <p v-else class="text-sm text-gray-400">No timeline data available</p>
              </div>

              <!-- Buyer -->
              <div>
                <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Buyer Details</h3>
                <div class="grid grid-cols-3 gap-3 text-sm">
                  <div><p class="text-xs text-gray-400">Name</p><p class="font-medium text-gray-800">{{ selected.buyer_name || '—' }}</p></div>
                  <div><p class="text-xs text-gray-400">Phone</p><p class="text-gray-700">{{ selected.buyer_phone || '—' }}</p></div>
                  <div><p class="text-xs text-gray-400">Email</p><p class="text-gray-700 break-all">{{ selected.buyer_email || '—' }}</p></div>
                </div>
                <div class="mt-2 text-sm">
                  <p class="text-xs text-gray-400">Delivery Address</p>
                  <p class="text-gray-700">
                    {{ [getAddress(selected).street || getAddress(selected).building, getAddress(selected).city, getAddress(selected).state, getAddress(selected).area_code].filter(Boolean).join(', ') || selected.delivery_city || '—' }}
                  </p>
                </div>
              </div>

              <!-- Items -->
              <div>
                <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Items Ordered</h3>
                <div class="divide-y divide-gray-100 rounded-lg border border-gray-100">
                  <div v-if="!getItems(selected).length" class="py-3 text-center text-sm text-gray-400">No item data</div>
                  <div v-for="(item, idx) in getItems(selected)" :key="idx"
                    class="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span class="font-mono text-xs text-gray-500">{{ item.id }}</span>
                    <span class="text-gray-700">&times; {{ item.quantity?.count || item.quantity || 1 }}</span>
                    <span class="font-medium text-gray-900">{{ item.price?.value ? formatCurrency(item.price.value) : '—' }}</span>
                  </div>
                </div>
              </div>

              <!-- Amount + Payment -->
              <div class="flex items-center justify-between rounded-lg bg-green-50 px-4 py-3">
                <div>
                  <p class="text-xs text-gray-500">Total Amount</p>
                  <p class="text-xl font-bold text-gray-900">{{ formatCurrency(selected.total_amount) }}</p>
                </div>
                <div class="text-right">
                  <p class="text-xs text-gray-500">Payment</p>
                  <p class="text-sm font-medium capitalize text-gray-700">{{ selected.payment_type || '—' }}</p>
                  <p class="text-xs text-gray-500">{{ selected.payment_status || '' }}</p>
                </div>
              </div>

              <!-- Protocol Logs Toggle -->
              <div>
                <button @click="fetchLogs"
                  class="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50">
                  {{ showLogs ? 'Hide' : 'Show' }} Protocol Logs ({{ protocolLogs.length || '...' }})
                </button>
                <div v-if="showLogs && protocolLogs.length" class="mt-3 space-y-2">
                  <div v-for="log in protocolLogs" :key="log.id"
                    class="rounded-lg border border-gray-100 overflow-hidden">
                    <button @click="toggleLog(log.id)"
                      class="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs hover:bg-gray-50">
                      <div class="flex items-center gap-2">
                        <span class="font-mono font-semibold" :class="log.direction === 'outbound' ? 'text-green-700' : 'text-blue-700'">
                          {{ log.action }}
                        </span>
                        <span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{{ log.direction }}</span>
                        <span :class="['rounded px-1.5 py-0.5 text-[10px]', log.status === 'success' ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600']">
                          {{ log.status }}
                        </span>
                      </div>
                      <span class="text-gray-400">{{ formatDateTime(log.timestamp) }}</span>
                    </button>
                    <div v-if="expandedLog === log.id" class="border-t border-gray-100 bg-gray-50 px-4 py-3">
                      <div class="mb-2">
                        <p class="text-[10px] font-semibold text-gray-500 mb-1">Request Payload</p>
                        <pre class="max-h-48 overflow-auto rounded bg-white p-2 text-[11px] text-gray-700 ring-1 ring-gray-200">{{ JSON.stringify(log.request_payload, null, 2) }}</pre>
                      </div>
                      <div v-if="log.response_payload">
                        <p class="text-[10px] font-semibold text-gray-500 mb-1">Response</p>
                        <pre class="max-h-32 overflow-auto rounded bg-white p-2 text-[11px] text-gray-700 ring-1 ring-gray-200">{{ JSON.stringify(log.response_payload, null, 2) }}</pre>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Status update -->
              <div>
                <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Update Status</h3>
                <div class="flex gap-3">
                  <select v-model="newStatus"
                    class="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500">
                    <option v-for="s in updateStatuses" :key="s" :value="s" class="capitalize">{{ s }}</option>
                  </select>
                  <button @click="saveStatus" :disabled="updatingStatus || newStatus === selected.status"
                    class="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
                    {{ updatingStatus ? 'Saving…' : 'Update' }}
                  </button>
                </div>
              </div>

              <!-- Dates -->
              <div class="grid grid-cols-3 gap-3 text-xs text-gray-500">
                <div><p class="mb-0.5 text-gray-400">Created</p>{{ formatDate(selected.created_at) }}</div>
                <div><p class="mb-0.5 text-gray-400">Updated</p>{{ formatDate(selected.updated_at) }}</div>
                <div><p class="mb-0.5 text-gray-400">Delivered</p>{{ formatDate(selected.delivered_at) }}</div>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
