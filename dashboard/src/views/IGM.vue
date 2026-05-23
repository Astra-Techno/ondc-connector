<script setup>
import { ref, onMounted } from 'vue'
import { get, put } from '@/utils/api'
import { useToast } from '@/stores/toast'
import { AlertCircle, RefreshCw, CheckCircle, Clock, MessageSquare, X } from 'lucide-vue-next'

const toast   = useToast()
const loading = ref(true)
const error   = ref(null)
const issues  = ref([])
const total   = ref(0)
const page    = ref(1)
const filters = ref({ status: '' })

const selected   = ref(null)
const showModal  = ref(false)
const updating   = ref(false)
const editForm   = ref({ status: '', resolution: '', remarks: '' })

const statusClass = {
  open:        'bg-red-100 text-red-700',
  in_progress: 'bg-yellow-100 text-yellow-700',
  resolved:    'bg-green-100 text-green-700',
  closed:      'bg-gray-100 text-gray-600',
}
const statusIcon = { open: AlertCircle, in_progress: Clock, resolved: CheckCircle, closed: X }

async function fetchIssues() {
  loading.value = true
  error.value   = null
  const params  = { page: page.value, per_page: 50 }
  if (filters.value.status) params.status = filters.value.status

  const { data, error: err } = await get('/igm', params)
  if (err) { error.value = err }
  else {
    issues.value = data.issues || []
    total.value  = data.total  || 0
  }
  loading.value = false
}

function openIssue(issue) {
  selected.value  = issue
  editForm.value  = { status: issue.status, resolution: issue.resolution || '', remarks: issue.remarks || '' }
  showModal.value = true
}

function closeModal() {
  showModal.value = false
  selected.value  = null
}

async function saveUpdate() {
  if (!selected.value) return
  updating.value = true
  const { error: err } = await put(`/igm/${selected.value.id}`, editForm.value)
  if (err) { toast.error(err) }
  else {
    toast.success('Issue updated')
    closeModal()
    fetchIssues()
  }
  updating.value = false
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function applyFilters() { page.value = 1; fetchIssues() }

onMounted(fetchIssues)
</script>

<template>
  <div class="p-6 space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold text-gray-900">Issue & Grievances (IGM)</h1>
      <button @click="fetchIssues" :disabled="loading" class="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
        <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" /> Refresh
      </button>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100">
      <select v-model="filters.status" class="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500">
        <option value="">All Status</option>
        <option value="open">Open</option>
        <option value="in_progress">In Progress</option>
        <option value="resolved">Resolved</option>
        <option value="closed">Closed</option>
      </select>
      <button @click="applyFilters" class="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">Apply</button>
      <button @click="filters.status = ''; applyFilters()" class="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Clear</button>
    </div>

    <!-- Error -->
    <div v-if="error" class="flex items-center gap-3 rounded-lg bg-red-50 p-4 text-red-700">
      <AlertCircle class="h-5 w-5 shrink-0" /> {{ error }}
    </div>

    <!-- Table -->
    <div class="rounded-xl bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
      <div v-if="loading" class="space-y-3 p-4">
        <div v-for="i in 5" :key="i" class="h-10 animate-pulse rounded-lg bg-gray-100" />
      </div>
      <div v-else-if="!issues.length" class="py-16 text-center text-sm text-gray-400">
        No issues found
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th class="px-4 py-3 text-left font-medium">Issue ID</th>
              <th class="px-4 py-3 text-left font-medium">Order ID</th>
              <th class="px-4 py-3 text-left font-medium">Type</th>
              <th class="px-4 py-3 text-left font-medium">Description</th>
              <th class="px-4 py-3 text-left font-medium">Raised By</th>
              <th class="px-4 py-3 text-left font-medium">Status</th>
              <th class="px-4 py-3 text-left font-medium">Raised At</th>
              <th class="px-4 py-3 text-left font-medium">Action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            <tr v-for="issue in issues" :key="issue.id" class="hover:bg-gray-50/50">
              <td class="px-4 py-3 font-mono text-xs text-gray-500">{{ issue.issue_id?.substring(0, 8) }}…</td>
              <td class="px-4 py-3 font-mono text-xs text-gray-600">{{ issue.order_id || '—' }}</td>
              <td class="px-4 py-3">
                <span class="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 capitalize">
                  {{ issue.issue_type || '—' }}
                </span>
              </td>
              <td class="px-4 py-3 max-w-[200px] truncate text-gray-700" :title="issue.description">
                {{ issue.description || '—' }}
              </td>
              <td class="px-4 py-3 text-gray-600">
                <div>{{ issue.complainant_name  || '—' }}</div>
                <div class="text-xs text-gray-400">{{ issue.complainant_phone || '' }}</div>
              </td>
              <td class="px-4 py-3">
                <span :class="['flex items-center gap-1 w-fit rounded-full px-2 py-0.5 text-xs font-medium capitalize', statusClass[issue.status] || 'bg-gray-100 text-gray-600']">
                  <component :is="statusIcon[issue.status] || AlertCircle" class="h-3 w-3" />
                  {{ issue.status?.replace('_', ' ') }}
                </span>
              </td>
              <td class="px-4 py-3 text-gray-500 whitespace-nowrap">{{ formatDate(issue.created_at) }}</td>
              <td class="px-4 py-3">
                <button @click="openIssue(issue)" class="flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50">
                  <MessageSquare class="h-3 w-3" /> Update
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div v-if="total > 50" class="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-sm text-gray-500">
        <span>{{ total }} total</span>
        <div class="flex gap-2">
          <button @click="page--; fetchIssues()" :disabled="page === 1" class="rounded border border-gray-200 px-3 py-1 hover:bg-gray-50 disabled:opacity-40">Prev</button>
          <span class="px-2 py-1">Page {{ page }}</span>
          <button @click="page++; fetchIssues()" :disabled="page * 50 >= total" class="rounded border border-gray-200 px-3 py-1 hover:bg-gray-50 disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>

    <!-- Detail / Update Modal -->
    <Teleport to="body">
      <Transition enter-active-class="transition-opacity duration-200" enter-from-class="opacity-0" leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
        <div v-if="showModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="closeModal">
          <div class="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
            <!-- Header -->
            <div class="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <h2 class="font-semibold text-gray-900">Update Issue</h2>
              <button @click="closeModal" class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"><X class="h-4 w-4" /></button>
            </div>

            <div v-if="selected" class="space-y-4 p-6">
              <!-- Issue info -->
              <div class="space-y-2 rounded-lg bg-gray-50 p-4 text-sm">
                <div class="flex justify-between">
                  <span class="text-gray-500">Issue ID</span>
                  <span class="font-mono text-xs text-gray-700">{{ selected.issue_id }}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-500">Order ID</span>
                  <span class="text-gray-700">{{ selected.order_id || '—' }}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-500">Type</span>
                  <span class="capitalize text-gray-700">{{ selected.issue_type }}</span>
                </div>
                <div>
                  <span class="text-gray-500">Description</span>
                  <p class="mt-1 text-gray-700">{{ selected.description || '—' }}</p>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-500">Complainant</span>
                  <span class="text-gray-700">{{ selected.complainant_name }} · {{ selected.complainant_phone }}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-500">Raised At</span>
                  <span class="text-gray-700">{{ formatDate(selected.created_at) }}</span>
                </div>
              </div>

              <!-- Update form -->
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Status</label>
                <select v-model="editForm.status" class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500">
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </select>
              </div>

              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Resolution</label>
                <textarea v-model="editForm.resolution" rows="3" placeholder="Describe the resolution…"
                  class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none" />
              </div>

              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">Internal Remarks</label>
                <textarea v-model="editForm.remarks" rows="2" placeholder="Internal notes…"
                  class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none" />
              </div>
            </div>

            <div class="flex justify-end gap-3 border-t border-gray-100 px-6 py-4">
              <button @click="closeModal" class="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
              <button @click="saveUpdate" :disabled="updating" class="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
                {{ updating ? 'Saving…' : 'Save Update' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
