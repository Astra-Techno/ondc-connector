import { defineStore } from 'pinia'

let nextId = 0

export const useToastStore = defineStore('toast', {
  state: () => ({
    toasts: [],
  }),

  actions: {
    addToast(message, type = 'info', duration = 4000) {
      const id = ++nextId
      this.toasts.push({ id, message, type })
      setTimeout(() => this.removeToast(id), duration)
      return id
    },

    removeToast(id) {
      const idx = this.toasts.findIndex((t) => t.id === id)
      if (idx !== -1) this.toasts.splice(idx, 1)
    },
  },
})

export function useToast() {
  const store = useToastStore()
  return {
    success: (msg) => store.addToast(msg, 'success'),
    error:   (msg) => store.addToast(msg, 'error'),
    warning: (msg) => store.addToast(msg, 'warning'),
    info:    (msg) => store.addToast(msg, 'info'),
    remove:  (id)  => store.removeToast(id),
  }
}
