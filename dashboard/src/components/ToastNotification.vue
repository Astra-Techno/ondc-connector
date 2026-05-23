<script setup>
import { useToastStore } from '@/stores/toast'
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-vue-next'

const toast = useToastStore()

const icons = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
}

const styles = {
  success: 'bg-white border-l-4 border-green-500',
  error:   'bg-white border-l-4 border-red-500',
  warning: 'bg-white border-l-4 border-yellow-400',
  info:    'bg-white border-l-4 border-blue-500',
}

const iconStyles = {
  success: 'text-green-500',
  error:   'text-red-500',
  warning: 'text-yellow-400',
  info:    'text-blue-500',
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80">
      <TransitionGroup
        enter-active-class="transition-all duration-300 ease-out"
        enter-from-class="opacity-0 translate-x-8"
        enter-to-class="opacity-100 translate-x-0"
        leave-active-class="transition-all duration-200 ease-in"
        leave-from-class="opacity-100 translate-x-0"
        leave-to-class="opacity-0 translate-x-8"
      >
        <div
          v-for="t in toast.toasts"
          :key="t.id"
          :class="['flex items-start gap-3 rounded-lg p-4 shadow-lg', styles[t.type]]"
        >
          <component
            :is="icons[t.type]"
            :class="['h-5 w-5 shrink-0 mt-0.5', iconStyles[t.type]]"
          />
          <p class="flex-1 text-sm text-gray-700">{{ t.message }}</p>
          <button
            @click="toast.removeToast(t.id)"
            class="shrink-0 text-gray-400 hover:text-gray-600"
          >
            <X class="h-4 w-4" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
