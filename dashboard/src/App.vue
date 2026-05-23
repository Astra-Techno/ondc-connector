<script setup>
import { onMounted } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AppLayout from '@/components/AppLayout.vue'

const auth = useAuthStore()
const route = useRoute()

onMounted(async () => {
  await auth.init()
})
</script>

<template>
  <AppLayout v-if="auth.isAuthenticated" />

  <!-- Unauthenticated: full page (login etc.) -->
  <div v-else class="min-h-screen">
    <RouterView v-slot="{ Component }">
      <Transition
        enter-active-class="transition-opacity duration-150"
        enter-from-class="opacity-0"
        leave-active-class="transition-opacity duration-100"
        leave-to-class="opacity-0"
        mode="out-in"
      >
        <component :is="Component" :key="route.path" />
      </Transition>
    </RouterView>

    <!-- Toast available on login page too -->
    <ToastNotification />
  </div>
</template>
