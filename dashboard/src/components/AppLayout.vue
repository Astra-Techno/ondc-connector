<script setup>
import { ref } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import {
  LayoutDashboard,
  Store,
  Package,
  ShoppingCart,
  RefreshCw,
  Webhook,
  Settings,
  Shield,
  LogOut,
  Menu,
  X,
  Zap,
  CreditCard,
  MessageSquare,
} from 'lucide-vue-next'

const auth = useAuthStore()
const router = useRouter()
const sidebarOpen = ref(false)

const navItems = [
  { to: '/dashboard',   label: 'Dashboard',   icon: LayoutDashboard },
  { to: '/vendors',     label: 'Vendors',     icon: Store },
  { to: '/products',    label: 'Products',    icon: Package },
  { to: '/orders',      label: 'Orders',      icon: ShoppingCart },
  { to: '/settlements', label: 'Settlements', icon: CreditCard },
  { to: '/igm',         label: 'IGM',         icon: MessageSquare },
  { to: '/sync-logs',   label: 'Sync Logs',   icon: RefreshCw },
  { to: '/webhooks',    label: 'Webhooks',    icon: Webhook },
  { to: '/settings',    label: 'Settings',    icon: Settings },
]

function handleLogout() {
  auth.logout()
  router.push('/login')
}

function closeSidebar() {
  sidebarOpen.value = false
}
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-gray-50">

    <!-- Mobile backdrop -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      leave-active-class="transition-opacity duration-200"
      leave-to-class="opacity-0"
    >
      <div
        v-if="sidebarOpen"
        class="fixed inset-0 z-20 bg-black/40 md:hidden"
        @click="closeSidebar"
      />
    </Transition>

    <!-- Sidebar -->
    <aside
      :class="[
        'fixed inset-y-0 left-0 z-30 flex w-60 flex-col transition-transform duration-200 ease-in-out',
        'md:relative md:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      ]"
      style="background-color: #15803d;"
    >
      <!-- Branding -->
      <div class="flex h-16 items-center gap-3 px-5" style="background-color: #14532d;">
        <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-white/20">
          <Zap class="h-4 w-4 text-white" :stroke-width="2.5" />
        </div>
        <div class="leading-tight">
          <p class="text-sm font-bold tracking-wide text-white">ONDC Connector</p>
          <p class="text-[10px] text-green-200/70">by Cottkart</p>
        </div>
      </div>

      <!-- Nav -->
      <nav class="flex-1 overflow-y-auto px-3 py-4">
        <ul class="space-y-0.5">
          <li v-for="item in navItems" :key="item.to">
            <RouterLink
              :to="item.to"
              @click="closeSidebar"
              class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-green-100/80 transition-colors hover:bg-white/10 hover:text-white"
              active-class="!bg-white/20 !text-white"
            >
              <component :is="item.icon" class="h-4 w-4 shrink-0" />
              {{ item.label }}
            </RouterLink>
          </li>

          <li v-if="auth.tenant?.role === 'admin'">
            <RouterLink
              to="/admin"
              @click="closeSidebar"
              class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-green-100/80 transition-colors hover:bg-white/10 hover:text-white"
              active-class="!bg-white/20 !text-white"
            >
              <Shield class="h-4 w-4 shrink-0" />
              Admin
            </RouterLink>
          </li>
        </ul>
      </nav>

      <!-- Tenant / Logout -->
      <div class="border-t border-white/10 p-4">
        <div v-if="auth.tenant" class="mb-3 px-1">
          <p class="truncate text-sm font-semibold text-white">{{ auth.tenant.name }}</p>
          <p class="text-[11px] capitalize text-green-200/60">{{ auth.tenant.role }}</p>
        </div>
        <button
          @click="handleLogout"
          class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-green-100/70 transition-colors hover:bg-red-500/20 hover:text-red-200"
        >
          <LogOut class="h-4 w-4 shrink-0" />
          Log out
        </button>
      </div>
    </aside>

    <!-- Right: header + content -->
    <div class="flex flex-1 flex-col overflow-hidden">

      <!-- Top header -->
      <header class="flex h-16 shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 md:px-6">
        <button
          class="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 md:hidden"
          @click="sidebarOpen = !sidebarOpen"
          aria-label="Toggle sidebar"
        >
          <Menu v-if="!sidebarOpen" class="h-5 w-5" />
          <X v-else class="h-5 w-5" />
        </button>

        <div class="flex-1">
          <slot name="header" />
        </div>

        <!-- Tenant badge -->
        <div
          v-if="auth.tenant"
          class="flex items-center gap-2 rounded-full px-3 py-1.5"
          style="background-color: #f0fdf4;"
        >
          <div class="h-2 w-2 rounded-full" style="background-color: #15803d;" />
          <span class="text-sm font-medium" style="color: #15803d;">{{ auth.tenant.name }}</span>
        </div>

        <!-- Logout (desktop) -->
        <button
          @click="handleLogout"
          class="hidden items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:border-red-200 hover:text-red-500 md:flex"
        >
          <LogOut class="h-4 w-4" />
          Logout
        </button>
      </header>

      <!-- Main content -->
      <main class="flex-1 overflow-y-auto">
        <RouterView v-slot="{ Component, route }">
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
      </main>
    </div>

    <!-- Global toast -->
    <ToastNotification />
  </div>
</template>
