<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { Eye, EyeOff, Loader2, ArrowRight, Zap } from 'lucide-vue-next'

const router = useRouter()
const auth = useAuthStore()

const apiKey = ref('')
const showKey = ref(false)
const error = ref('')

async function handleLogin() {
  error.value = ''
  if (!apiKey.value.trim()) {
    error.value = 'Please enter your API key.'
    return
  }
  try {
    await auth.login(apiKey.value.trim())
    const redirect = router.currentRoute.value.query.redirect || '/dashboard'
    router.push(redirect)
  } catch {
    error.value = auth.error || 'Invalid API key. Please try again.'
  }
}
</script>

<template>
  <!-- Full-page animated gradient background -->
  <div class="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12" style="background: linear-gradient(135deg, #0f2416 0%, #14532d 40%, #166534 70%, #0f2416 100%);">

    <!-- Ambient glow blobs -->
    <div class="pointer-events-none absolute inset-0 overflow-hidden">
      <div class="absolute -top-40 -left-40 h-96 w-96 rounded-full opacity-20 blur-3xl" style="background: radial-gradient(circle, #4ade80, transparent);" />
      <div class="absolute top-1/2 -right-40 h-80 w-80 rounded-full opacity-15 blur-3xl" style="background: radial-gradient(circle, #86efac, transparent);" />
      <div class="absolute -bottom-32 left-1/3 h-72 w-72 rounded-full opacity-10 blur-3xl" style="background: radial-gradient(circle, #22c55e, transparent);" />
    </div>

    <!-- Grid pattern overlay -->
    <div class="pointer-events-none absolute inset-0 opacity-5" style="background-image: linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px); background-size: 40px 40px;" />

    <!-- Card -->
    <div class="relative w-full max-w-md">

      <!-- Glass card -->
      <div class="relative overflow-hidden rounded-3xl border border-white/10 p-8 shadow-2xl backdrop-blur-2xl" style="background: rgba(255,255,255,0.07);">

        <!-- Subtle inner highlight -->
        <div class="pointer-events-none absolute inset-x-0 top-0 h-px" style="background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);" />

        <!-- Logo + branding -->
        <div class="mb-8 text-center">
          <div class="relative mx-auto mb-5 flex h-16 w-16 items-center justify-center">
            <!-- Glow ring -->
            <div class="absolute inset-0 rounded-2xl opacity-60 blur-md" style="background: #22c55e;" />
            <div class="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-white/20 shadow-xl" style="background: linear-gradient(135deg, #16a34a, #15803d);">
              <Zap class="h-8 w-8 text-white drop-shadow" :stroke-width="2.5" />
            </div>
          </div>

          <h1 class="text-2xl font-bold tracking-tight text-white">ONDC Connector</h1>
          <p class="mt-2 text-sm" style="color: rgba(134,239,172,0.8);">Connect your store to ONDC network</p>
        </div>

        <!-- Divider -->
        <div class="mb-6 flex items-center gap-3">
          <div class="h-px flex-1" style="background: rgba(255,255,255,0.1);" />
          <span class="text-xs font-medium uppercase tracking-widest" style="color: rgba(255,255,255,0.3);">Sign in</span>
          <div class="h-px flex-1" style="background: rgba(255,255,255,0.1);" />
        </div>

        <!-- Form -->
        <form @submit.prevent="handleLogin" class="space-y-4">

          <!-- API Key field -->
          <div>
            <label class="mb-2 block text-xs font-semibold uppercase tracking-widest" style="color: rgba(134,239,172,0.9);">
              API Key
            </label>
            <div class="relative">
              <input
                v-model="apiKey"
                :type="showKey ? 'text' : 'password'"
                placeholder="ck_live_..."
                autocomplete="current-password"
                class="w-full rounded-xl border py-3.5 pl-4 pr-11 text-sm font-mono text-white placeholder-white/25 outline-none transition-all duration-200"
                :class="error
                  ? 'border-red-400/50 bg-red-500/10 focus:border-red-400 focus:ring-2 focus:ring-red-500/20'
                  : 'border-white/10 bg-white/5 focus:border-green-400/60 focus:bg-white/10 focus:ring-2 focus:ring-green-500/20'"
              />
              <button
                type="button"
                @click="showKey = !showKey"
                class="absolute right-3.5 top-1/2 -translate-y-1/2 rounded-md p-1 transition-colors"
                style="color: rgba(255,255,255,0.35);"
                tabindex="-1"
              >
                <EyeOff v-if="showKey" class="h-4 w-4" />
                <Eye v-else class="h-4 w-4" />
              </button>
            </div>
          </div>

          <!-- Error message -->
          <div v-if="error" class="flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3">
            <div class="h-1.5 w-1.5 rounded-full bg-red-400 shrink-0" />
            <p class="text-sm text-red-300">{{ error }}</p>
          </div>

          <!-- Submit button -->
          <button
            type="submit"
            :disabled="auth.isLoading"
            class="group relative mt-2 flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl py-3.5 text-sm font-semibold text-white shadow-lg transition-all duration-200 disabled:opacity-60"
            style="background: linear-gradient(135deg, #16a34a, #15803d);"
          >
            <!-- Hover shimmer -->
            <div class="absolute inset-0 translate-x-[-100%] bg-gradient-to-r from-transparent via-white/10 to-transparent transition-transform duration-700 group-hover:translate-x-[100%]" />
            <Loader2 v-if="auth.isLoading" class="h-4 w-4 animate-spin" />
            <span>{{ auth.isLoading ? 'Signing in…' : 'Sign in' }}</span>
            <ArrowRight v-if="!auth.isLoading" class="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </button>
        </form>

        <!-- Footer inside card -->
        <p class="mt-6 text-center text-xs" style="color: rgba(255,255,255,0.2);">
          Secured with API key authentication
        </p>
      </div>

      <!-- Below card -->
      <p class="mt-6 text-center text-xs" style="color: rgba(134,239,172,0.3);">
        ONDC Connector &copy; {{ new Date().getFullYear() }} &middot; by Cottkart
      </p>
    </div>
  </div>
</template>
