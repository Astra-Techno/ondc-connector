<script setup>
import { ref, onMounted } from 'vue'
import { get, post, del } from '@/utils/api'
import { useToast } from '@/stores/toast'
import {
  Plus, Trash2, AlertCircle, Webhook,
  ShoppingCart, XCircle, RotateCcw, CreditCard, AlertTriangle, X,
} from 'lucide-vue-next'

const toast = useToast()
const loading = ref(true)
const error = ref(null)
const webhooks = ref([])
const showModal = ref(false)
const saving = ref(false)
const deleteConfirm = ref(null)

const eventIcons = {
  'order.confirmed':  ShoppingCart,
  'order.cancelled':  XCircle,
  'order.returned':   RotateCcw,
  'payment.received': CreditCard,
  'igm.raised':       AlertTriangle,
}

const form = ref({
  event: 'order.confirmed',
  url: '',
  secret: '',
})

const eventOptions = Object.keys(eventIcons)

async function fetchWebhooks() {
  loading.value = true
  error.value = null
  const { data, error: err } = await get('/webhooks')
  if (err) error.value = err
  else webhooks.value = data?.webhooks || data || []
  loading.value = false
}

async function saveWebhook() {
  if (!form.value.url) { toast.error('URL is required'); return }
  saving.value = true
  const { error: err } = await post('/webhooks', form.value)
  if (err) {
    toast.error('Failed to save: ' + err)
  } else {
    toast.success('Webhook created')
    showModal.value = false
    form.value = { event: 'order.confirmed', url: '', secret: '' }
    fetchWebhooks()
  }
  saving.value = false
}

async function deleteWebhook(id) {
  const { error: err } = await del(`/webhooks/${id}`)
  if (err) toast.error('Delete failed: ' + err)
  else {
    toast.success('Webhook deleted')
    webhooks.value = webhooks.value.filter(w => w.id !== id)
  }
  deleteConfirm.value = null
}

function formatDate(d) {
  if (!d) return 'Never'
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

onMounted(fetchWebhooks)
</script>

<template>
  <div class="p-6 space-y-5">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold text-gray-900">Webhooks</h1>
      <button
        @click="showModal = true"
        class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white"
        style="background-color: #15803d;"
      >
        <Plus class="h-4 w-4" /> Add Webhook
      </button>
    </div>

    <div v-if="error" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-sm text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ error }}
    </div>

    <!-- Skeleton -->
    <div v-if="loading" class="space-y-3">
      <div v-for="i in 3" :key="i" class="h-24 animate-pulse rounded-xl bg-gray-200" />
    </div>

    <!-- Webhook cards -->
    <div v-else-if="webhooks.length" class="space-y-3">
      <div
        v-for="wh in webhooks" :key="wh.id"
        class="flex flex-col gap-3 rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100 sm:flex-row sm:items-center"
      >
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100">
          <component :is="eventIcons[wh.event] || Webhook" class="h-5 w-5 text-gray-600" />
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-medium text-gray-800">{{ wh.event }}</p>
          <p class="truncate text-sm text-gray-500">{{ wh.url }}</p>
          <p class="text-xs text-gray-400 mt-0.5">Last triggered: {{ formatDate(wh.last_triggered_at) }}</p>
        </div>

        <!-- Status toggle -->
        <div class="flex items-center gap-1 text-xs" :class="wh.active ? 'text-green-600' : 'text-gray-400'">
          <div class="h-2 w-2 rounded-full" :class="wh.active ? 'bg-green-500' : 'bg-gray-300'" />
          {{ wh.active ? 'Active' : 'Inactive' }}
        </div>

        <!-- Delete -->
        <div class="flex items-center gap-2">
          <template v-if="deleteConfirm === wh.id">
            <span class="text-xs text-gray-500">Sure?</span>
            <button @click="deleteWebhook(wh.id)" class="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Yes</button>
            <button @click="deleteConfirm = null" class="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100">No</button>
          </template>
          <button v-else @click="deleteConfirm = wh.id" class="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500">
            <Trash2 class="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>

    <!-- Empty -->
    <div v-else class="rounded-xl bg-white py-16 text-center shadow-sm ring-1 ring-gray-100">
      <Webhook class="mx-auto mb-3 h-10 w-10 text-gray-200" />
      <p class="text-sm text-gray-400">No webhooks configured</p>
    </div>

    <!-- Modal -->
    <Teleport to="body">
      <Transition enter-active-class="transition-opacity duration-200" enter-from-class="opacity-0" leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
        <div v-if="showModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4">
            <div class="flex items-center justify-between">
              <h2 class="text-lg font-semibold text-gray-900">Add Webhook</h2>
              <button @click="showModal = false" class="text-gray-400 hover:text-gray-600"><X class="h-5 w-5" /></button>
            </div>

            <div class="space-y-3">
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-700">Event</label>
                <select v-model="form.event" class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-green-500">
                  <option v-for="e in eventOptions" :key="e" :value="e">{{ e }}</option>
                </select>
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-700">Webhook URL</label>
                <input v-model="form.url" type="url" placeholder="https://your-server.com/webhook" class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/20" />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-700">Secret Key <span class="text-gray-400">(optional)</span></label>
                <input v-model="form.secret" type="password" placeholder="Signing secret" class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/20" />
              </div>
            </div>

            <div class="flex justify-end gap-3 pt-2">
              <button @click="showModal = false" class="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
              <button
                @click="saveWebhook"
                :disabled="saving"
                class="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                style="background-color: #15803d;"
              >
                {{ saving ? 'Saving…' : 'Save Webhook' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
