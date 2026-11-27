<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { get, put } from '@/utils/api'
import { useToast } from '@/stores/toast'
import { ArrowLeft, AlertCircle, Loader2, RefreshCw, Truck, Package, Copy, Check } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const loading = ref(true)
const updating = ref(false)
const err = ref(null)
const order = ref(null)
const newStatus = ref('')
const trackingId = ref('')
const timeline = ref([])
const protocolLogs = ref([])
const showLogs = ref(false)
const expandedLog = ref(null)
const loadingTimeline = ref(false)
const copied = ref(null)

const statusOptions = ['confirmed', 'packed', 'shipped', 'delivered', 'cancelled']

const statusBadge = {
  confirmed: 'bg-blue-100 text-blue-700',
  packed:    'bg-yellow-100 text-yellow-700',
  shipped:   'bg-orange-100 text-orange-700',
  delivered: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
}

const fulfillmentBadge = {
  'Delivery':       'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200',
  'Buyer-Delivery': 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
}

const fulfillmentStateBadge = {
  'Pending':           'bg-gray-100 text-gray-600',
  'Serviceable':       'bg-gray-100 text-gray-500',
  'Created':           'bg-gray-100 text-gray-600',
  'Accepted':          'bg-blue-50 text-blue-600',
  'Packed':            'bg-yellow-50 text-yellow-700',
  'Agent-assigned':    'bg-blue-100 text-blue-700',
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

async function fetchOrder() {
  loading.value = true
  err.value = null
  const { data, error: e } = await get(`/orders/${route.params.id}`)
  if (e) { err.value = e }
  else {
    order.value = data
    newStatus.value = data.status
  }
  loading.value = false
}

async function fetchTimeline() {
  loadingTimeline.value = true
  const { data } = await get(`/orders/${route.params.id}/timeline`)
  timeline.value = data || []
  loadingTimeline.value = false
}

async function fetchLogs() {
  if (protocolLogs.value.length) { showLogs.value = !showLogs.value; return }
  const { data } = await get(`/orders/${route.params.id}/logs`)
  protocolLogs.value = data || []
  showLogs.value = true
}

function toggleLog(id) {
  expandedLog.value = expandedLog.value === id ? null : id
}

async function updateStatus() {
  updating.value = true
  const payload = { status: newStatus.value }
  if (newStatus.value === 'shipped' && trackingId.value) payload.tracking_id = trackingId.value
  const { error: e } = await put(`/orders/${route.params.id}/status`, payload)
  if (e) {
    toast.error('Failed to update status: ' + e)
  } else {
    toast.success('Order status updated')
    order.value.status = newStatus.value
  }
  updating.value = false
}

function getItems() {
  return order.value?.items_parsed || []
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = label
    setTimeout(() => { copied.value = null }, 1500)
  } catch {}
}

function formatAddress(addr) {
  if (!addr) return '—'
  return [addr.name || addr.door, addr.building, addr.street || addr.locality, addr.city, addr.state, addr.area_code].filter(Boolean).join(', ')
}

function formatCurrency(v) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

onMounted(() => {
  fetchOrder()
  fetchTimeline()
})
</script>

<template>
  <div class="p-6 space-y-5 max-w-4xl">
    <!-- Back -->
    <button @click="router.push('/orders')" class="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700">
      <ArrowLeft class="h-4 w-4" /> Back to Orders
    </button>

    <!-- Loading -->
    <div v-if="loading" class="space-y-4">
      <div v-for="i in 3" :key="i" class="h-40 animate-pulse rounded-xl bg-gray-200" />
    </div>

    <div v-else-if="err" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ err }}
    </div>

    <template v-else-if="order">
      <!-- Order header -->
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div class="flex items-center gap-3">
            <h1 class="text-xl font-bold text-gray-900">Order #{{ order.ondc_order_id }}</h1>
            <span :class="['inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium', fulfillmentBadge[order.fulfillment_type] || 'bg-gray-100 text-gray-500']">
              <Truck v-if="order.fulfillment_type === 'Delivery'" class="h-3 w-3" />
              <Package v-else class="h-3 w-3" />
              {{ order.fulfillment_type || 'Delivery' }}
            </span>
          </div>
          <p class="text-sm text-gray-500 mt-0.5">{{ formatDate(order.created_at) }}</p>
        </div>
        <div class="flex items-center gap-3 flex-wrap">
          <span :class="['rounded-full px-3 py-1 text-sm font-semibold capitalize', statusBadge[order.status] || 'bg-gray-100 text-gray-600']">
            {{ order.status }}
          </span>
          <span v-if="order.fulfillment_status" :class="['rounded-full px-3 py-1 text-sm font-semibold', fulfillmentStateBadge[order.fulfillment_status] || 'bg-gray-100 text-gray-600']">
            {{ order.fulfillment_status }}
          </span>
          <span v-if="order.fulfillment_id" class="rounded-full bg-gray-100 px-3 py-1 text-sm font-mono text-gray-700">
            {{ order.fulfillment_id }}
          </span>
        </div>
      </div>

      <!-- IDs -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-lg bg-gray-50 p-3 space-y-1">
          <p class="text-[10px] font-medium uppercase text-gray-400">Transaction ID</p>
          <div class="flex items-center gap-1">
            <p class="font-mono text-xs text-gray-700 break-all">{{ order.transaction_id || '—' }}</p>
            <button v-if="order.transaction_id" @click="copyText(order.transaction_id, 'txn')" class="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-600">
              <Check v-if="copied === 'txn'" class="h-3 w-3 text-green-500" /><Copy v-else class="h-3 w-3" />
            </button>
          </div>
        </div>
        <div class="rounded-lg bg-gray-50 p-3 space-y-1">
          <p class="text-[10px] font-medium uppercase text-gray-400">BAP ID</p>
          <div class="flex items-center gap-1">
            <p class="font-mono text-xs text-gray-700">{{ order.bap_id || '—' }}</p>
            <button v-if="order.bap_id" @click="copyText(order.bap_id, 'bap')" class="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-600">
              <Check v-if="copied === 'bap'" class="h-3 w-3 text-green-500" /><Copy v-else class="h-3 w-3" />
            </button>
          </div>
        </div>
        <div class="rounded-lg bg-gray-50 p-3 space-y-1">
          <p class="text-[10px] font-medium uppercase text-gray-400">Provider</p>
          <p class="font-mono text-xs text-gray-700">{{ order.provider_id || '—' }}</p>
          <p v-if="order.provider_name" class="text-[10px] text-gray-500">{{ order.provider_name }}</p>
        </div>
        <div v-if="order.cottkart_order_id" class="rounded-lg bg-gray-50 p-3 space-y-1">
          <p class="text-[10px] font-medium uppercase text-gray-400">CottKart ID</p>
          <p class="font-mono text-xs text-gray-700">{{ order.cottkart_order_id }}</p>
        </div>
      </div>

      <div class="grid gap-4 sm:grid-cols-3">
        <!-- Buyer Info -->
        <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100 space-y-2">
          <h2 class="font-semibold text-gray-800">Buyer Info</h2>
          <div class="text-sm space-y-1">
            <p><span class="text-gray-500">Name:</span> <span class="text-gray-800">{{ order.buyer_name || '—' }}</span></p>
            <p><span class="text-gray-500">Phone:</span> <span class="text-gray-800">{{ order.buyer_phone || '—' }}</span></p>
            <p><span class="text-gray-500">Email:</span> <span class="text-gray-800">{{ order.buyer_email || '—' }}</span></p>
          </div>
        </div>

        <!-- Delivery Address -->
        <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100 space-y-2">
          <h2 class="font-semibold text-gray-800">Delivery Address</h2>
          <p class="text-sm text-gray-700 leading-relaxed">
            {{ formatAddress(order.delivery_address_parsed) }}
          </p>
        </div>

        <!-- Payment Info -->
        <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100 space-y-2">
          <h2 class="font-semibold text-gray-800">Payment</h2>
          <div class="text-sm space-y-1">
            <p><span class="text-gray-500">Type:</span> <span class="text-gray-800">{{ order.payment_type || '—' }}</span></p>
            <p><span class="text-gray-500">Status:</span> <span class="text-gray-800">{{ order.payment_status || '—' }}</span></p>
            <p><span class="text-gray-500">Amount:</span> <span class="font-semibold text-gray-900">{{ formatCurrency(order.total_amount) }}</span></p>
          </div>
        </div>
      </div>

      <!-- Order items -->
      <div class="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-100">
        <div class="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <span class="font-semibold text-gray-800">Order Items</span>
          <span v-if="getItems().length" class="text-xs text-gray-500">
            {{ order.items_count }} distinct / {{ order.items_units }} units
          </span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th class="px-5 py-3 text-left font-medium">Item ID</th>
                <th class="px-5 py-3 text-left font-medium">Name</th>
                <th class="px-5 py-3 text-right font-medium">Qty</th>
                <th class="px-5 py-3 text-right font-medium">Price</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              <tr v-if="!getItems().length">
                <td colspan="4" class="px-5 py-6 text-center text-sm text-gray-400">No item data available</td>
              </tr>
              <tr v-for="item in getItems()" :key="item.id" class="hover:bg-gray-50/50">
                <td class="px-5 py-3 font-mono text-xs text-gray-700">{{ item.id }}</td>
                <td class="px-5 py-3 text-gray-700">{{ item.descriptor?.name || '—' }}</td>
                <td class="px-5 py-3 text-right text-gray-600">{{ item.quantity?.count || item.quantity || 1 }}</td>
                <td class="px-5 py-3 text-right font-medium text-gray-900">{{ item.price?.value ? formatCurrency(item.price.value) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="border-t border-gray-100 px-5 py-3 text-right font-bold text-gray-900">
          Total: {{ formatCurrency(order.total_amount) }}
        </div>
      </div>

      <!-- Fulfillment Timeline -->
      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <h2 class="font-semibold text-gray-800 mb-4">Fulfillment Timeline</h2>
        <div v-if="loadingTimeline" class="flex items-center gap-2 text-sm text-gray-400">
          <RefreshCw class="h-4 w-4 animate-spin" /> Loading timeline...
        </div>
        <div v-else-if="timeline.length" class="relative ml-3 border-l-2 border-gray-200 pl-6 space-y-4">
          <div v-for="(evt, idx) in timeline" :key="idx" class="relative">
            <div class="absolute -left-[30px] top-1 h-3.5 w-3.5 rounded-full border-2 border-white"
              :class="evt.direction === 'outbound' ? 'bg-green-500' : 'bg-blue-500'"></div>
            <div class="flex items-baseline gap-2 flex-wrap">
              <span class="font-mono text-sm font-semibold" :class="evt.direction === 'outbound' ? 'text-green-700' : 'text-blue-700'">
                {{ evt.action }}
              </span>
              <span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{{ evt.direction }}</span>
              <span v-if="evt.fulfillment_state" :class="['rounded px-1.5 py-0.5 text-[10px] font-medium', fulfillmentStateBadge[evt.fulfillment_state] || 'bg-indigo-50 text-indigo-600']">
                {{ evt.fulfillment_state }}
              </span>
              <span v-if="evt.order_state" class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                Order: {{ evt.order_state }}
              </span>
              <span v-if="evt.fulfillment_id" class="rounded bg-gray-50 px-1 py-0.5 text-[10px] font-mono text-gray-400">
                {{ evt.fulfillment_id }}
              </span>
            </div>
            <p class="text-xs text-gray-400 mt-0.5">{{ formatDateTime(evt.timestamp) }}</p>
          </div>
        </div>
        <div v-else class="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-700">
          No timeline events could be extracted. Check protocol logs below for raw data.
        </div>
      </div>

      <!-- Protocol Logs -->
      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-semibold text-gray-800">Protocol Logs</h2>
          <button @click="fetchLogs"
            class="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
            {{ showLogs ? 'Hide' : 'Show' }} Logs
          </button>
        </div>
        <div v-if="showLogs && protocolLogs.length" class="space-y-2 max-h-[500px] overflow-y-auto">
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
                <pre class="max-h-64 overflow-auto rounded bg-white p-3 text-[11px] text-gray-700 ring-1 ring-gray-200 whitespace-pre-wrap break-all">{{ JSON.stringify(log.request_payload, null, 2) }}</pre>
              </div>
              <div v-if="log.response_payload">
                <p class="text-[10px] font-semibold text-gray-500 mb-1">Response</p>
                <pre class="max-h-40 overflow-auto rounded bg-white p-3 text-[11px] text-gray-700 ring-1 ring-gray-200 whitespace-pre-wrap break-all">{{ JSON.stringify(log.response_payload, null, 2) }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Status Update -->
      <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100 space-y-4">
        <h2 class="font-semibold text-gray-800">Update Status</h2>
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div class="flex-1">
            <label class="mb-1 block text-xs font-medium text-gray-600">New Status</label>
            <select v-model="newStatus" class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500">
              <option v-for="s in statusOptions" :key="s" :value="s" class="capitalize">{{ s }}</option>
            </select>
          </div>
          <div v-if="newStatus === 'shipped'" class="flex-1">
            <label class="mb-1 block text-xs font-medium text-gray-600">Tracking ID</label>
            <input v-model="trackingId" placeholder="Tracking ID" class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-green-500" />
          </div>
          <button
            @click="updateStatus"
            :disabled="updating"
            class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 bg-green-700 hover:bg-green-800"
          >
            <Loader2 v-if="updating" class="h-4 w-4 animate-spin" />
            {{ updating ? 'Updating…' : 'Update Status' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
