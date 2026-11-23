<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { get } from '@/utils/api'
import {
  RefreshCw, ArrowDownLeft, ArrowUpRight,
  Play, Radio, CheckCircle2, Clock, AlertTriangle, Shield, Zap,
  MessageSquare, ChevronRight,
} from 'lucide-vue-next'

const flows = ref([])
const selectedTxn = ref('')
const steps = ref([])
const loading = ref(false)
const loadingFlows = ref(true)
const expanded = ref(null)
const autoRefresh = ref(true)
let timer = null

// IGM state colors and labels
const stateConfig = {
  OPEN:                  { color: 'bg-red-100 text-red-700 ring-red-200',           dot: 'bg-red-500' },
  PROCESSING:            { color: 'bg-yellow-100 text-yellow-700 ring-yellow-200',  dot: 'bg-yellow-500' },
  'NEED-MORE-INFO':      { color: 'bg-orange-100 text-orange-700 ring-orange-200',  dot: 'bg-orange-500' },
  INFO_PROVIDED:         { color: 'bg-blue-100 text-blue-700 ring-blue-200',        dot: 'bg-blue-500' },
  RESOLUTION_PROPOSED:   { color: 'bg-indigo-100 text-indigo-700 ring-indigo-200',  dot: 'bg-indigo-500' },
  RESOLUTION_ACCEPTED:   { color: 'bg-emerald-100 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500' },
  RESOLUTION_REJECTED:   { color: 'bg-pink-100 text-pink-700 ring-pink-200',        dot: 'bg-pink-500' },
  ESCALATED:             { color: 'bg-purple-100 text-purple-700 ring-purple-200',  dot: 'bg-purple-500' },
  RESOLVED:              { color: 'bg-green-100 text-green-700 ring-green-200',     dot: 'bg-green-500' },
  CLOSED:                { color: 'bg-gray-100 text-gray-600 ring-gray-200',        dot: 'bg-gray-500' },
}

const actionMeta = {
  issue:           { label: 'Issue',         icon: AlertTriangle, side: 'left',  desc: 'BAP raises issue' },
  on_issue:        { label: 'On Issue',      icon: MessageSquare, side: 'right', desc: 'BPP responds' },
  issue_status:    { label: 'Issue Status',  icon: Clock,         side: 'left',  desc: 'BAP requests status' },
  on_issue_status: { label: 'On Issue Status', icon: Shield,      side: 'right', desc: 'BPP sends status' },
  on_update:       { label: 'On Update',     icon: Zap,           side: 'right', desc: 'BPP sends update (refund/close)' },
  on_status:       { label: 'On Status',     icon: CheckCircle2,  side: 'right', desc: 'BPP sends final status' },
}

function extractIssueStatus(step) {
  try {
    const p = typeof step.payload === 'string' ? JSON.parse(step.payload) : step.payload
    // Outbound (on_issue, on_issue_status, on_update, on_status): issue status in message.issue.status
    // Inbound (issue): status in message.issue.status
    return p?.message?.issue?.status || p?.message?.order?.state || null
  } catch { return null }
}

function extractIssueAction(step) {
  try {
    const p = typeof step.payload === 'string' ? JSON.parse(step.payload) : step.payload
    const actions = p?.message?.issue?.actions
    if (Array.isArray(actions) && actions.length) {
      return actions[actions.length - 1]?.descriptor?.code || null
    }
    // IGM 1.0 — respondent_actions
    const resp = p?.message?.issue?.issue_actions?.respondent_actions
    if (Array.isArray(resp) && resp.length) {
      return resp[resp.length - 1]?.respondent_action || null
    }
    const comp = p?.message?.issue?.issue_actions?.complainant_actions
    if (Array.isArray(comp) && comp.length) {
      return comp[comp.length - 1]?.complainant_action || null
    }
    return null
  } catch { return null }
}

const enrichedSteps = computed(() =>
  steps.value.map((s, i) => ({
    ...s,
    stepNum: i + 1,
    meta: actionMeta[s.action] || { label: s.action, icon: Circle, side: s.direction === 'inbound' ? 'left' : 'right', desc: '' },
    issueStatus: extractIssueStatus(s),
    issueAction: extractIssueAction(s),
  }))
)

const currentState = computed(() => {
  for (let i = enrichedSteps.value.length - 1; i >= 0; i--) {
    const st = enrichedSteps.value[i].issueStatus
    if (st) return st
  }
  return null
})

const isFlowComplete = computed(() => ['CLOSED', 'RESOLVED'].includes(currentState.value))

function prettyJson(raw) {
  try { return JSON.stringify(typeof raw === 'string' ? JSON.parse(raw) : raw, null, 2) }
  catch { return raw || '' }
}

function formatTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function relativeTime(d) {
  if (!d) return ''
  const diff = Date.now() - new Date(d).getTime()
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

async function fetchFlows() {
  loadingFlows.value = true
  const { data } = await get('/dashboard/igm-flows')
  flows.value = data?.flows || []
  loadingFlows.value = false
}

async function fetchSteps() {
  if (!selectedTxn.value) return
  loading.value = true
  const { data } = await get(`/dashboard/igm-flow/${selectedTxn.value}`)
  const prevLen = steps.value.length
  steps.value = data?.steps || []
  loading.value = false
  // Auto-scroll to new step
  if (steps.value.length > prevLen) {
    await nextTick()
    const el = document.getElementById(`step-${steps.value.length}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

function selectFlow(txnId) {
  selectedTxn.value = txnId
  steps.value = []
  expanded.value = null
  fetchSteps()
}

function toggleExpand(id) {
  expanded.value = expanded.value === id ? null : id
}

function startPolling() {
  stopPolling()
  timer = setInterval(() => {
    if (autoRefresh.value && selectedTxn.value) fetchSteps()
  }, 3000)
}

function stopPolling() {
  if (timer) { clearInterval(timer); timer = null }
}

function timeDelta(a, b) {
  if (!a || !b) return '—'
  const ms = Math.abs(new Date(b) - new Date(a))
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

onMounted(() => {
  fetchFlows()
  startPolling()
})
onUnmounted(stopPolling)
</script>

<template>
  <div class="p-6 space-y-6 max-w-6xl mx-auto">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 flex items-center gap-3">
          <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 shadow-lg shadow-green-200">
            <Shield class="h-5 w-5 text-white" />
          </div>
          IGM Workflow Logs
        </h1>
        <p class="text-sm text-gray-500 mt-1 ml-[52px]">Live issue & grievance management workflow visualization</p>
      </div>
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
          <div class="relative">
            <input type="checkbox" v-model="autoRefresh" class="sr-only peer" />
            <div class="h-5 w-9 rounded-full bg-gray-200 peer-checked:bg-green-500 transition-colors" />
            <div class="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
          </div>
          <Radio class="h-3.5 w-3.5" :class="autoRefresh ? 'text-green-500 animate-pulse' : 'text-gray-400'" />
          Live
        </label>
        <button @click="fetchFlows" :disabled="loadingFlows"
          class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
          <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loadingFlows }" />
        </button>
      </div>
    </div>

    <!-- Flow Selector -->
    <div class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
      <div class="flex items-center gap-3 mb-3">
        <Play class="h-4 w-4 text-green-600" />
        <span class="text-sm font-semibold text-gray-700">Select IGM Flow</span>
        <span v-if="flows.length" class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">{{ flows.length }} flows</span>
      </div>

      <div v-if="loadingFlows" class="space-y-2">
        <div v-for="i in 3" :key="i" class="h-14 animate-pulse rounded-xl bg-gray-100" />
      </div>

      <div v-else-if="!flows.length" class="py-8 text-center text-sm text-gray-400">
        <Shield class="mx-auto mb-2 h-8 w-8 text-gray-200" />
        No IGM flows found. Trigger an IGM flow from ONDC Workbench to see it here.
      </div>

      <div v-else class="space-y-2 max-h-60 overflow-y-auto">
        <button
          v-for="f in flows" :key="f.transaction_id"
          @click="selectFlow(f.transaction_id)"
          :class="[
            'w-full flex items-center gap-4 rounded-xl px-4 py-3 text-left transition-all',
            selectedTxn === f.transaction_id
              ? 'bg-green-50 ring-2 ring-green-500 shadow-sm'
              : 'bg-gray-50 hover:bg-gray-100 ring-1 ring-gray-100'
          ]"
        >
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            :class="selectedTxn === f.transaction_id ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'">
            <MessageSquare class="h-4 w-4" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-mono text-xs text-gray-700 truncate">{{ f.transaction_id }}</span>
              <span class="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600">
                {{ f.step_count }} steps
              </span>
            </div>
            <div class="flex items-center gap-3 mt-0.5 text-[11px] text-gray-400">
              <span>{{ formatDate(f.started_at) }}</span>
              <span>{{ relativeTime(f.last_activity) }}</span>
            </div>
          </div>
          <ChevronRight class="h-4 w-4 shrink-0 text-gray-300" />
        </button>
      </div>
    </div>

    <!-- Timeline -->
    <div v-if="selectedTxn" class="rounded-2xl bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
      <!-- Timeline header -->
      <div class="flex items-center justify-between border-b border-gray-100 px-6 py-4">
        <div class="flex items-center gap-3">
          <h2 class="font-semibold text-gray-800">Flow Timeline</h2>
          <span v-if="currentState" :class="['inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1', stateConfig[currentState]?.color || 'bg-gray-100 text-gray-600 ring-gray-200']">
            <span class="h-1.5 w-1.5 rounded-full" :class="stateConfig[currentState]?.dot || 'bg-gray-400'" />
            {{ currentState }}
          </span>
          <span v-if="isFlowComplete" class="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-medium text-green-600 ring-1 ring-green-200">
            <CheckCircle2 class="h-3 w-3" /> Complete
          </span>
          <span v-else-if="autoRefresh" class="inline-flex items-center gap-1 text-[10px] text-green-500">
            <Radio class="h-3 w-3 animate-pulse" /> Watching...
          </span>
        </div>
        <span class="text-xs text-gray-400">{{ enrichedSteps.length }} steps</span>
      </div>

      <!-- Legend -->
      <div class="flex items-center gap-6 border-b border-gray-50 px-6 py-2.5 bg-gray-50/50">
        <div class="flex items-center gap-2 text-xs text-blue-600">
          <ArrowDownLeft class="h-3.5 w-3.5" />
          <span class="font-medium">BAP → BPP</span>
          <span class="text-gray-400">(Inbound)</span>
        </div>
        <div class="flex items-center gap-2 text-xs text-green-600">
          <ArrowUpRight class="h-3.5 w-3.5" />
          <span class="font-medium">BPP → BAP</span>
          <span class="text-gray-400">(Outbound)</span>
        </div>
      </div>

      <!-- Steps -->
      <div v-if="loading && !steps.length" class="p-6 space-y-4">
        <div v-for="i in 4" :key="i" class="h-20 animate-pulse rounded-xl bg-gray-100" />
      </div>

      <div v-else-if="!steps.length" class="py-16 text-center text-sm text-gray-400">
        <Clock class="mx-auto mb-2 h-8 w-8 text-gray-200" />
        Waiting for IGM steps...
      </div>

      <div v-else class="relative px-6 py-6">
        <!-- Center line -->
        <div class="absolute left-1/2 top-6 bottom-6 w-px bg-gradient-to-b from-gray-200 via-gray-300 to-gray-200 -translate-x-px" />

        <div v-for="(step, idx) in enrichedSteps" :key="step.id" :id="`step-${step.stepNum}`" class="relative mb-6 last:mb-0">
          <!-- Step card -->
          <div :class="[
            'relative grid grid-cols-[1fr_40px_1fr] items-start gap-0',
          ]">
            <!-- Left side (inbound) -->
            <div :class="step.meta.side === 'left' ? '' : 'invisible'">
              <div
                @click="toggleExpand(step.id)"
                :class="[
                  'cursor-pointer rounded-xl p-4 transition-all hover:shadow-md',
                  step.meta.side === 'left'
                    ? 'bg-blue-50 ring-1 ring-blue-100 hover:ring-blue-200 ml-auto mr-0 max-w-md'
                    : ''
                ]"
              >
                <div class="flex items-center gap-2 mb-1.5">
                  <span class="flex h-6 w-6 items-center justify-center rounded-md bg-blue-100 text-blue-600">
                    <component :is="step.meta.icon" class="h-3.5 w-3.5" />
                  </span>
                  <span class="font-mono text-xs font-bold text-blue-700">{{ step.action }}</span>
                  <ArrowDownLeft class="h-3 w-3 text-blue-400" />
                </div>
                <p class="text-xs text-gray-500 mb-2">{{ step.meta.desc }}</p>
                <div class="flex flex-wrap items-center gap-2">
                  <span v-if="step.issueStatus" :class="['inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1', stateConfig[step.issueStatus]?.color || 'bg-gray-100 text-gray-600 ring-gray-200']">
                    {{ step.issueStatus }}
                  </span>
                  <span v-if="step.issueAction" class="rounded-full bg-white/80 px-2 py-0.5 text-[10px] text-gray-500 ring-1 ring-gray-200">
                    {{ step.issueAction }}
                  </span>
                  <span class="text-[10px] text-gray-400 ml-auto">{{ formatTime(step.created_at) }}</span>
                </div>
                <!-- Expanded payload -->
                <Transition enter-active-class="transition-all duration-200" enter-from-class="opacity-0 max-h-0" enter-to-class="opacity-100 max-h-[600px]"
                  leave-active-class="transition-all duration-150" leave-from-class="opacity-100 max-h-[600px]" leave-to-class="opacity-0 max-h-0">
                  <div v-if="expanded === step.id" class="mt-3 overflow-hidden">
                    <div class="rounded-lg bg-gray-900 p-3">
                      <div class="text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-1">Request Payload</div>
                      <pre class="whitespace-pre-wrap break-all text-[11px] text-green-300 font-mono max-h-72 overflow-y-auto">{{ prettyJson(step.payload) }}</pre>
                    </div>
                    <div v-if="step.response" class="mt-2 rounded-lg bg-gray-900 p-3">
                      <div class="text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-1">Response</div>
                      <pre class="whitespace-pre-wrap break-all text-[11px] text-yellow-300 font-mono max-h-40 overflow-y-auto">{{ prettyJson(step.response) }}</pre>
                    </div>
                  </div>
                </Transition>
              </div>
            </div>

            <!-- Center dot -->
            <div class="flex flex-col items-center justify-start pt-3 z-10">
              <div :class="[
                'flex h-8 w-8 items-center justify-center rounded-full text-white text-xs font-bold shadow-lg',
                step.direction === 'inbound'
                  ? 'bg-gradient-to-br from-blue-500 to-blue-600 shadow-blue-200'
                  : 'bg-gradient-to-br from-green-500 to-emerald-600 shadow-green-200'
              ]">
                {{ step.stepNum }}
              </div>
            </div>

            <!-- Right side (outbound) -->
            <div :class="step.meta.side === 'right' ? '' : 'invisible'">
              <div
                @click="toggleExpand(step.id)"
                :class="[
                  'cursor-pointer rounded-xl p-4 transition-all hover:shadow-md',
                  step.meta.side === 'right'
                    ? 'bg-green-50 ring-1 ring-green-100 hover:ring-green-200 mr-auto ml-0 max-w-md'
                    : ''
                ]"
              >
                <div class="flex items-center gap-2 mb-1.5">
                  <ArrowUpRight class="h-3 w-3 text-green-400" />
                  <span class="font-mono text-xs font-bold text-green-700">{{ step.action }}</span>
                  <span class="flex h-6 w-6 items-center justify-center rounded-md bg-green-100 text-green-600">
                    <component :is="step.meta.icon" class="h-3.5 w-3.5" />
                  </span>
                </div>
                <p class="text-xs text-gray-500 mb-2">{{ step.meta.desc }}</p>
                <div class="flex flex-wrap items-center gap-2">
                  <span v-if="step.issueStatus" :class="['inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1', stateConfig[step.issueStatus]?.color || 'bg-gray-100 text-gray-600 ring-gray-200']">
                    {{ step.issueStatus }}
                  </span>
                  <span v-if="step.issueAction" class="rounded-full bg-white/80 px-2 py-0.5 text-[10px] text-gray-500 ring-1 ring-gray-200">
                    {{ step.issueAction }}
                  </span>
                  <span class="text-[10px] text-gray-400 ml-auto">{{ formatTime(step.created_at) }}</span>
                </div>
                <!-- Expanded payload -->
                <Transition enter-active-class="transition-all duration-200" enter-from-class="opacity-0 max-h-0" enter-to-class="opacity-100 max-h-[600px]"
                  leave-active-class="transition-all duration-150" leave-from-class="opacity-100 max-h-[600px]" leave-to-class="opacity-0 max-h-0">
                  <div v-if="expanded === step.id" class="mt-3 overflow-hidden">
                    <div class="rounded-lg bg-gray-900 p-3">
                      <div class="text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-1">Request Payload</div>
                      <pre class="whitespace-pre-wrap break-all text-[11px] text-green-300 font-mono max-h-72 overflow-y-auto">{{ prettyJson(step.payload) }}</pre>
                    </div>
                    <div v-if="step.response" class="mt-2 rounded-lg bg-gray-900 p-3">
                      <div class="text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-1">Response</div>
                      <pre class="whitespace-pre-wrap break-all text-[11px] text-yellow-300 font-mono max-h-40 overflow-y-auto">{{ prettyJson(step.response) }}</pre>
                    </div>
                  </div>
                </Transition>
              </div>
            </div>
          </div>

          <!-- Time delta between steps -->
          <div v-if="idx < enrichedSteps.length - 1" class="flex justify-center my-1">
            <span class="text-[10px] text-gray-300 bg-white px-2 py-0.5 rounded-full z-10 relative">
              +{{ timeDelta(step.created_at, enrichedSteps[idx + 1].created_at) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty state when no flow selected -->
    <div v-else-if="!loadingFlows && flows.length" class="rounded-2xl bg-white py-20 text-center shadow-sm ring-1 ring-gray-100">
      <Shield class="mx-auto mb-3 h-12 w-12 text-gray-200" />
      <p class="text-sm text-gray-400">Select an IGM flow above to view its timeline</p>
    </div>
  </div>
</template>

