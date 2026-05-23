<script setup>
import { ref, computed, onMounted } from 'vue'
import { get } from '@/utils/api'
import { Shield, Search, AlertCircle } from 'lucide-vue-next'

const loading = ref(true)
const error = ref(null)
const tenants = ref([])
const search = ref('')

const typeBadge = {
  single_store: 'bg-blue-100 text-blue-700',
  multi_vendor: 'bg-purple-100 text-purple-700',
}

const statusBadge = {
  active:    'bg-green-100 text-green-700',
  inactive:  'bg-gray-100 text-gray-500',
  suspended: 'bg-red-100 text-red-700',
}

const planBadge = {
  starter:      'bg-gray-100 text-gray-600',
  professional: 'bg-blue-100 text-blue-700',
  enterprise:   'bg-purple-100 text-purple-700',
}

const filtered = computed(() => {
  if (!search.value) return tenants.value
  const q = search.value.toLowerCase()
  return tenants.value.filter(t =>
    t.name?.toLowerCase().includes(q) || t.slug?.toLowerCase().includes(q)
  )
})

const summary = computed(() => ({
  total:        tenants.value.length,
  active:       tenants.value.filter(t => t.status === 'active').length,
  single_store: tenants.value.filter(t => t.platform_type === 'single_store').length,
  multi_vendor: tenants.value.filter(t => t.platform_type === 'multi_vendor').length,
}))

async function fetchTenants() {
  loading.value = true
  error.value = null
  const { data, error: err } = await get('/admin/tenants')
  if (err) error.value = err
  else tenants.value = data?.tenants || data || []
  loading.value = false
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

onMounted(fetchTenants)
</script>

<template>
  <div class="p-6 space-y-5">
    <!-- Header -->
    <div class="flex items-center gap-3">
      <Shield class="h-6 w-6 text-gray-700" />
      <h1 class="text-xl font-bold text-gray-900">Admin — All Tenants</h1>
    </div>

    <!-- Summary stats -->
    <div v-if="!loading" class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100 text-center">
        <p class="text-2xl font-bold text-gray-900">{{ summary.total }}</p>
        <p class="text-xs text-gray-500 mt-0.5">Total Tenants</p>
      </div>
      <div class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100 text-center">
        <p class="text-2xl font-bold text-green-700">{{ summary.active }}</p>
        <p class="text-xs text-gray-500 mt-0.5">Active</p>
      </div>
      <div class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100 text-center">
        <p class="text-2xl font-bold text-blue-700">{{ summary.single_store }}</p>
        <p class="text-xs text-gray-500 mt-0.5">Single Store</p>
      </div>
      <div class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100 text-center">
        <p class="text-2xl font-bold text-purple-700">{{ summary.multi_vendor }}</p>
        <p class="text-xs text-gray-500 mt-0.5">Multi Vendor</p>
      </div>
    </div>

    <!-- Search -->
    <div class="relative">
      <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <input v-model="search" placeholder="Search by name or slug…" class="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/20" />
    </div>

    <div v-if="error" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-sm text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ error }}
    </div>

    <div class="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-100">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th class="px-5 py-3 text-left font-medium">ID</th>
              <th class="px-5 py-3 text-left font-medium">Name</th>
              <th class="px-5 py-3 text-left font-medium">Slug</th>
              <th class="px-5 py-3 text-left font-medium">Domain</th>
              <th class="px-5 py-3 text-left font-medium">Type</th>
              <th class="px-5 py-3 text-left font-medium">Plan</th>
              <th class="px-5 py-3 text-left font-medium">Status</th>
              <th class="px-5 py-3 text-right font-medium">Vendors</th>
              <th class="px-5 py-3 text-right font-medium">Products</th>
              <th class="px-5 py-3 text-right font-medium">Orders</th>
              <th class="px-5 py-3 text-left font-medium">Created</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            <template v-if="loading">
              <tr v-for="i in 6" :key="i">
                <td v-for="j in 11" :key="j" class="px-5 py-3">
                  <div class="h-4 w-16 animate-pulse rounded bg-gray-100" />
                </td>
              </tr>
            </template>
            <template v-else-if="filtered.length">
              <tr
                v-for="t in filtered" :key="t.id"
                class="cursor-pointer hover:bg-gray-50/60"
              >
                <td class="px-5 py-3 font-mono text-xs text-gray-400">{{ t.id }}</td>
                <td class="px-5 py-3 font-medium text-gray-900">{{ t.name }}</td>
                <td class="px-5 py-3 font-mono text-xs text-gray-500">{{ t.slug }}</td>
                <td class="px-5 py-3 text-gray-500 max-w-[140px] truncate">{{ t.domain || '—' }}</td>
                <td class="px-5 py-3">
                  <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', typeBadge[t.platform_type] || 'bg-gray-100 text-gray-500']">
                    {{ t.platform_type === 'single_store' ? 'Single Store' : t.platform_type === 'multi_vendor' ? 'Multi Vendor' : t.platform_type || '—' }}
                  </span>
                </td>
                <td class="px-5 py-3">
                  <span :class="['rounded-full px-2 py-0.5 text-xs font-medium capitalize', planBadge[t.plan] || 'bg-gray-100 text-gray-500']">
                    {{ t.plan || '—' }}
                  </span>
                </td>
                <td class="px-5 py-3">
                  <span :class="['rounded-full px-2 py-0.5 text-xs font-medium capitalize', statusBadge[t.status] || 'bg-gray-100 text-gray-500']">
                    {{ t.status || '—' }}
                  </span>
                </td>
                <td class="px-5 py-3 text-right text-gray-700">{{ t.vendor_count ?? '—' }}</td>
                <td class="px-5 py-3 text-right text-gray-700">{{ t.product_count ?? '—' }}</td>
                <td class="px-5 py-3 text-right text-gray-700">{{ t.order_count ?? '—' }}</td>
                <td class="px-5 py-3 text-gray-500">{{ formatDate(t.created_at) }}</td>
              </tr>
            </template>
            <tr v-else>
              <td colspan="11" class="px-5 py-16 text-center">
                <Shield class="mx-auto mb-3 h-10 w-10 text-gray-200" />
                <p class="text-sm text-gray-400">No tenants found</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
