<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { get } from '@/utils/api'
import { ArrowLeft, AlertCircle } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const loading = ref(true)
const error = ref(null)
const vendor = ref(null)

async function fetchVendor() {
  loading.value = true
  error.value = null
  const { data, error: err } = await get(`/vendors/${route.params.id}`)
  if (err) error.value = err
  else vendor.value = data
  loading.value = false
}

const statusBadge = {
  active:    'bg-green-100 text-green-700',
  pending:   'bg-yellow-100 text-yellow-700',
  suspended: 'bg-red-100 text-red-700',
}

onMounted(fetchVendor)
</script>

<template>
  <div class="p-6 space-y-5 max-w-3xl">
    <button @click="router.push('/vendors')" class="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700">
      <ArrowLeft class="h-4 w-4" /> Back to Vendors
    </button>

    <div v-if="loading" class="space-y-4">
      <div v-for="i in 2" :key="i" class="h-40 animate-pulse rounded-xl bg-gray-200" />
    </div>

    <div v-else-if="error" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ error }}
    </div>

    <template v-else-if="vendor">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-bold text-gray-900">{{ vendor.business_name }}</h1>
        <span :class="['rounded-full px-3 py-1 text-sm font-medium capitalize', statusBadge[vendor.ondc_status] || 'bg-gray-100 text-gray-500']">
          {{ vendor.ondc_status }}
        </span>
      </div>

      <div class="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
        <h2 class="mb-4 font-semibold text-gray-800">Vendor Details</h2>
        <div class="grid gap-4 sm:grid-cols-2 text-sm">
          <div><p class="text-gray-500">Vendor ID</p><p class="font-mono text-xs text-gray-700">{{ vendor.id }}</p></div>
          <div><p class="text-gray-500">GSTIN</p><p class="font-mono text-gray-700">{{ vendor.gstin || '—' }}</p></div>
          <div><p class="text-gray-500">Phone</p><p class="text-gray-700">{{ vendor.phone || '—' }}</p></div>
          <div><p class="text-gray-500">Email</p><p class="text-gray-700">{{ vendor.email || '—' }}</p></div>
          <div><p class="text-gray-500">City</p><p class="text-gray-700">{{ vendor.city || '—' }}</p></div>
          <div><p class="text-gray-500">State</p><p class="text-gray-700">{{ vendor.state || '—' }}</p></div>
        </div>
      </div>
    </template>
  </div>
</template>
