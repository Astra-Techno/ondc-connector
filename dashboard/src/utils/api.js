import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL
    ? `${import.meta.env.VITE_API_URL}/api/v1`
    : '/api/v1',
})

// Request interceptor: attach API key from localStorage
api.interceptors.request.use((config) => {
  const apiKey = localStorage.getItem('ondc_api_key')
  if (apiKey) {
    config.headers['X-API-Key'] = apiKey
  }
  return config
})

// Response interceptor: handle 401 by redirecting to login
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('ondc_api_key')
      localStorage.removeItem('ondc_is_admin')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

// Unwrap the standard { success, message, data } envelope
function unwrap(res) {
  return res?.data?.data !== undefined ? res.data.data : res?.data
}

export async function get(url, params) {
  try {
    const res = await api.get(url, { params })
    return { data: unwrap(res), error: null }
  } catch (err) {
    return { data: null, error: err.response?.data?.message || err.message }
  }
}

export async function post(url, body) {
  try {
    const res = await api.post(url, body)
    return { data: unwrap(res), error: null }
  } catch (err) {
    return { data: null, error: err.response?.data?.message || err.message }
  }
}

export async function put(url, body) {
  try {
    const res = await api.put(url, body)
    return { data: unwrap(res), error: null }
  } catch (err) {
    return { data: null, error: err.response?.data?.message || err.message }
  }
}

export async function del(url) {
  try {
    const res = await api.delete(url)
    return { data: unwrap(res), error: null }
  } catch (err) {
    return { data: null, error: err.response?.data?.message || err.message }
  }
}

export default api
