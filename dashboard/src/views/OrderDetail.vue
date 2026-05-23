<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { get, put } from '@/utils/api'
import { useToast } from '@/stores/toast'
import { ArrowLeft, AlertCircle, Loader2 } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const loading = ref(true)
const updating = ref(false)
const error = ref(null)
const order = ref(null)
const newStatus = ref('')
const trackingId = ref('')

const statusOptions = ['confirmed', 'packed', 'shipped', 'delivered', 'cancelled']

const statusBadge = {
  confirmed: 'bg-blue-100 text-blue-700',
  packed:    'bg-yellow-100 text-yellow-700',
  shipped:   'bg-orange-100 text-orange-700',
  delivered: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
}

async function fetchOrder() {
  loading.value = true
  error.value = null
  const { data, error: err } = await get(`/orders/${route.params.id}`)
  if (err) { error.value = err }
  else {
    order.value = data
    newStatus.value = data.status
  }
  loading.value = false
}

async function updateStatus() {
  updating.value = true
  const payload = { status: newStatus.value }
  if (newStatus.value === 'shipped' && trackingId.value) payload.tracking_id = trackingId.value
  const { error: err } = await put(`/orders/${route.params.id}/status`, payload)
  if (err) {
    toast.error('Failed to update status: ' + err)
  } else {
    toast.success('Order status updated')
    order.value.status = newStatus.value
  }
  updating.value = false
}

function formatCurrency(v) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

onMounted(fetchOrder)
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

    <div v-else-if="error" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ error }}
    </div>

    <template v-else-if="order">
      <!-- Order header -->
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 class="text-xl font-bold text-gray-900">Order #{{ order.id }}</h1>
          <p class="text-sm text-gray-500">{{ formatDate(order.created_at) }}</p>
        </div>
        <span :class="['rounded-full px-3 py-1 text-sm font-semibold capitalize', statusBadge[order.status] || 'bg-gray-100 text-gray-600']">
          {{ order.status }}
        </span>
      </div>

      <div class="grid gap-4 sm:grid-cols-3">
        <!-- Buyer Info -->
        <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100 space-y-2">
          <h2 class="font-semibold text-gray-800">Buyer Info</h2>
          <div class="text-sm space-y-1">
            <p><span class="text-gray-500">Name:</span> <span class="text-gray-800">{{ order.buyer?.name || '—' }}</span></p>
            <p><span class="text-gray-500">Phone:</span> <span class="text-gray-800">{{ order.buyer?.phone || '—' }}</span></p>
            <p><span class="text-gray-500">Email:</span> <span class="text-gray-800">{{ order.buyer?.email || '—' }}</span></p>
          </div>
        </div>

        <!-- Delivery Address -->
        <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100 space-y-2">
          <h2 class="font-semibold text-gray-800">Delivery Address</h2>
          <p class="text-sm text-gray-700 leading-relaxed">
            {{ order.delivery_address?.line1 }}<br v-if="order.delivery_address?.line1" />
            {{ order.delivery_address?.city }}, {{ order.delivery_address?.state }} {{ order.delivery_address?.pin }}
          </p>
        </div>

        <!-- Payment Info -->
        <div class="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100 space-y-2">
          <h2 class="font-semibold text-gray-800">Payment</h2>
          <div class="text-sm space-y-1">
            <p><span class="text-gray-500">Type:</span> <span class="text-gray-800 capitalize">{{ order.payment?.type || '—' }}</span></p>
            <p><span class="text-gray-500">Status:</span> <span class="text-gray-800 capitalize">{{ order.payment?.status || '—' }}</span></p>
            <p><span class="text-gray-500">Amount:</span> <span class="font-semibold text-gray-900">{{ formatCurrency(order.payment?.amount) }}</span></p>
          </div>
        </div>
      </div>

      <!-- Order items -->
      <div class="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-100">
        <div class="border-b border-gray-100 px-5 py-4 font-semibold text-gray-800">Order Items</div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th class="px-5 py-3 text-left font-medium">Product</th>
                <th class="px-5 py-3 text-right font-medium">Qty</th>
                <th class="px-5 py-3 text-right font-medium">Price</th>
                <th class="px-5 py-3 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              <tr v-for="item in order.items" :key="item.id" class="hover:bg-gray-50/50">
                <td class="px-5 py-3 font-medium text-gray-900">{{ item.name }}</td>
                <td class="px-5 py-3 text-right text-gray-600">{{ item.quantity }}</td>
                <td class="px-5 py-3 text-right text-gray-600">{{ formatCurrency(item.price) }}</td>
                <td class="px-5 py-3 text-right font-semibold text-gray-900">{{ formatCurrency(item.price * item.quantity) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="border-t border-gray-100 px-5 py-3 text-right font-bold text-gray-900">
          Total: {{ formatCurrency(order.amount) }}
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
            class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style="background-color: #15803d;"
          >
            <Loader2 v-if="updating" class="h-4 w-4 animate-spin" />
            {{ updating ? 'Updating…' : 'Update Status' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
