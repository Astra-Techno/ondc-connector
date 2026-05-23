<script setup>
import { ref, computed, onMounted } from 'vue'
import { get } from '@/utils/api'
import { useToast } from '@/stores/toast'
import { Copy, RefreshCw, AlertCircle, AlertTriangle, CheckCircle } from 'lucide-vue-next'

const toast = useToast()
const loading = ref(true)
const error = ref(null)
const tenant = ref(null)
const showKey = ref(false)
const regenConfirm = ref(false)

async function fetchTenant() {
  loading.value = true
  error.value = null
  const { data, error: err } = await get('/tenant/info')
  if (err) error.value = err
  else tenant.value = data
  loading.value = false
}

async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label} copied to clipboard`)
  } catch {
    toast.error('Copy failed')
  }
}

function maskedKey(key) {
  if (!key) return '—'
  return key.slice(0, 8) + '••••••••••••••••' + key.slice(-4)
}

const daysUntilExpiry = computed(() => {
  if (!tenant.value?.ondc?.key_valid_until) return null
  const diff = new Date(tenant.value.ondc.key_valid_until) - new Date()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
})

const planBadge = {
  starter:      'bg-gray-100 text-gray-600',
  professional: 'bg-blue-100 text-blue-700',
  enterprise:   'bg-purple-100 text-purple-700',
}

const statusBadge = {
  active:    'bg-green-100 text-green-700',
  inactive:  'bg-gray-100 text-gray-500',
  suspended: 'bg-red-100 text-red-700',
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

onMounted(fetchTenant)
</script>

<template>
  <div class="p-6 space-y-6 max-w-3xl">
    <h1 class="text-xl font-bold text-gray-900">Settings</h1>

    <div v-if="loading" class="space-y-4">
      <div v-for="i in 3" :key="i" class="h-44 animate-pulse rounded-xl bg-gray-200" />
    </div>

    <div v-else-if="error" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ error }}
    </div>

    <template v-else-if="tenant">
      <!-- Section 1: Account Info -->
      <div class="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100 space-y-4">
        <h2 class="font-semibold text-gray-800">Account Info</h2>
        <div class="grid gap-3 sm:grid-cols-2 text-sm">
          <div>
            <p class="text-gray-500">Tenant Name</p>
            <p class="font-medium text-gray-900">{{ tenant.name }}</p>
          </div>
          <div>
            <p class="text-gray-500">Slug</p>
            <p class="font-mono text-gray-800">{{ tenant.slug }}</p>
          </div>
          <div>
            <p class="text-gray-500">Domain</p>
            <p class="text-gray-800">{{ tenant.domain || '—' }}</p>
          </div>
          <div>
            <p class="text-gray-500">Platform Type</p>
            <p class="capitalize text-gray-800">{{ (tenant.type || tenant.platform_type || '—').replace('_', ' ') }}</p>
          </div>
          <div>
            <p class="text-gray-500">Status</p>
            <span :class="['rounded-full px-2 py-0.5 text-xs font-medium capitalize', statusBadge[tenant.status] || 'bg-gray-100 text-gray-500']">
              {{ tenant.status || '—' }}
            </span>
          </div>
          <div>
            <p class="text-gray-500">Plan</p>
            <span :class="['rounded-full px-2 py-0.5 text-xs font-medium capitalize', planBadge[tenant.plan] || 'bg-gray-100 text-gray-500']">
              {{ tenant.plan || '—' }}
            </span>
          </div>
        </div>
      </div>

      <!-- Section 2: API Key -->
      <div class="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100 space-y-4">
        <h2 class="font-semibold text-gray-800">API Key</h2>
        <div class="flex items-center gap-3">
          <code class="flex-1 rounded-lg bg-gray-50 px-3 py-2 font-mono text-sm text-gray-700 break-all">
            {{ showKey ? tenant.api_key : maskedKey(tenant.api_key) }}
          </code>
          <button @click="showKey = !showKey" class="shrink-0 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50">
            {{ showKey ? 'Hide' : 'Show' }}
          </button>
          <button @click="copyToClipboard(tenant.api_key, 'API key')" class="shrink-0 rounded-lg border border-gray-200 p-2 text-gray-600 hover:bg-gray-50">
            <Copy class="h-4 w-4" />
          </button>
        </div>

        <div class="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          <strong>Warning:</strong> Regenerating the API key will invalidate the current key immediately.
        </div>
        <div v-if="!regenConfirm">
          <button @click="regenConfirm = true" class="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:border-red-300 hover:text-red-600">
            <RefreshCw class="h-4 w-4" /> Regenerate Key
          </button>
        </div>
        <div v-else class="flex items-center gap-3 text-sm">
          <span class="text-gray-600">Are you sure?</span>
          <button class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700">Yes, Regenerate</button>
          <button @click="regenConfirm = false" class="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Cancel</button>
        </div>
      </div>

      <!-- Section 3: ONDC Configuration -->
      <div class="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100 space-y-4">
        <h2 class="font-semibold text-gray-800">ONDC Configuration</h2>

        <!-- Key expiry warning -->
        <div
          v-if="daysUntilExpiry !== null && daysUntilExpiry <= 30"
          class="flex items-center gap-3 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800"
        >
          <AlertTriangle class="h-4 w-4 shrink-0" />
          Your ONDC key expires in <strong>{{ daysUntilExpiry }} days</strong>. Please renew it soon.
        </div>

        <div class="grid gap-3 sm:grid-cols-2 text-sm">
          <div>
            <p class="text-gray-500">Subscriber ID</p>
            <div class="flex items-center gap-2">
              <p class="font-mono text-xs text-gray-800 break-all">{{ tenant.ondc?.subscriber_id || '—' }}</p>
              <button v-if="tenant.ondc?.subscriber_id" @click="copyToClipboard(tenant.ondc.subscriber_id, 'Subscriber ID')" class="shrink-0 text-gray-400 hover:text-gray-600"><Copy class="h-3.5 w-3.5" /></button>
            </div>
          </div>
          <div>
            <p class="text-gray-500">Subscriber URL</p>
            <div class="flex items-center gap-2">
              <p class="font-mono text-xs text-gray-800 break-all">{{ tenant.ondc?.subscriber_url || '—' }}</p>
              <button v-if="tenant.ondc?.subscriber_url" @click="copyToClipboard(tenant.ondc.subscriber_url, 'Subscriber URL')" class="shrink-0 text-gray-400 hover:text-gray-600"><Copy class="h-3.5 w-3.5" /></button>
            </div>
          </div>
          <div>
            <p class="text-gray-500">Environment</p>
            <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', tenant.ondc?.environment === 'prod' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700']">
              {{ tenant.ondc?.environment || 'preprod' }}
            </span>
          </div>
          <div>
            <p class="text-gray-500">Unique Key ID</p>
            <div class="flex items-center gap-2">
              <p class="font-mono text-xs text-gray-800 break-all">{{ tenant.ondc?.unique_key_id || '—' }}</p>
              <button v-if="tenant.ondc?.unique_key_id" @click="copyToClipboard(tenant.ondc.unique_key_id, 'Key ID')" class="shrink-0 text-gray-400 hover:text-gray-600"><Copy class="h-3.5 w-3.5" /></button>
            </div>
          </div>
          <div>
            <p class="text-gray-500">Key Valid From</p>
            <p class="text-gray-800">{{ formatDate(tenant.ondc?.key_valid_from) }}</p>
          </div>
          <div>
            <p class="text-gray-500">Key Valid Until</p>
            <p class="flex items-center gap-1.5 text-gray-800">
              {{ formatDate(tenant.ondc?.key_valid_until) }}
              <CheckCircle v-if="daysUntilExpiry > 30" class="h-3.5 w-3.5 text-green-500" />
              <AlertTriangle v-else-if="daysUntilExpiry !== null" class="h-3.5 w-3.5 text-yellow-500" />
            </p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
