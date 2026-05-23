import { defineStore } from 'pinia'
import api from '@/utils/api'

const API_KEY_STORAGE = 'ondc_api_key'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    apiKey: null,
    tenant: null,
    isAuthenticated: false,
    isLoading: false,
    error: null,
  }),

  actions: {
    async login(apiKey) {
      this.isLoading = true
      this.error = null
      try {
        // Save to localStorage first so the axios interceptor can attach the header
        localStorage.setItem(API_KEY_STORAGE, apiKey)
        this.apiKey = apiKey
        const success = await this.fetchTenantInfo()
        if (success) {
          this.isAuthenticated = true
        } else {
          // Invalid key — clean up
          localStorage.removeItem(API_KEY_STORAGE)
          this.apiKey = null
          this.isAuthenticated = false
          this.error = 'Invalid API key or unable to reach server'
          throw new Error(this.error)
        }
      } finally {
        this.isLoading = false
      }
    },

    logout() {
      this.apiKey = null
      this.tenant = null
      this.isAuthenticated = false
      this.error = null
      localStorage.removeItem(API_KEY_STORAGE)
      localStorage.removeItem('ondc_is_admin')
    },

    async fetchTenantInfo() {
      if (!this.apiKey) return false
      try {
        // Interceptor reads X-API-Key from localStorage automatically
        const res = await api.get('/tenant/info')
        const data = res.data?.data ?? res.data
        if (!data) return false
        this.tenant = data
        localStorage.setItem('ondc_is_admin', String(data?.role === 'admin'))
        return true
      } catch {
        return false
      }
    },

    async init() {
      const storedKey = localStorage.getItem(API_KEY_STORAGE)
      if (!storedKey) return
      this.apiKey = storedKey
      const success = await this.fetchTenantInfo()
      if (success) {
        this.isAuthenticated = true
      } else {
        this.logout()
      }
    },
  },
})
