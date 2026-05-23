const axios = require('axios');
const logger = require('../../utils/logger');

const CLOUDKART_API_URL = process.env.CLOUDKART_API_URL;
const CLOUDKART_API_KEY = process.env.CLOUDKART_API_KEY;

const headers = () => ({
  'Content-Type': 'application/json',
  'X-API-Key': CLOUDKART_API_KEY,
});

const normalizeProduct = (p) => ({
  product_id:      String(p.id),
  vendor_id:       String(p.vendor_id),
  name:            p.name,
  description:     p.description     || '',
  category:        p.category        || p.category_slug || 'grocery',
  hsn_code:        p.hsn_code        || '',
  price:           parseFloat(p.price),
  mrp:             parseFloat(p.mrp  || p.price),
  stock:           parseInt(p.stock  || 0),
  unit:            p.unit            || 'piece',
  images:          Array.isArray(p.images) ? p.images : (p.image_url ? [p.image_url] : []),
  is_returnable:   Boolean(p.is_returnable),
  is_cancellable:  p.is_cancellable !== false,
  time_to_ship:    p.time_to_ship    || 'PT24H',
  available_on_cod: p.available_on_cod !== false,
  is_active:       p.is_active       !== false,
});

const fetchProducts = async (vendorId = null, page = 1, limit = 50) => {
  try {
    const params = { page, limit };
    if (vendorId) params.vendor_id = vendorId;
    const response = await axios.get(`${CLOUDKART_API_URL}/api/products`, {
      params,
      headers: headers(),
      timeout: 30000,
    });
    const data = response.data?.data || response.data || [];
    return (Array.isArray(data) ? data : data.items || []).map(normalizeProduct);
  } catch (err) {
    logger.error('fetchProducts failed:', err.message);
    throw err;
  }
};

const fetchInventory = async (vendorId) => {
  try {
    const response = await axios.get(`${CLOUDKART_API_URL}/api/inventory`, {
      params: { vendor_id: vendorId },
      headers: headers(),
      timeout: 30000,
    });
    const data = response.data?.data || response.data || [];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.error(`fetchInventory(${vendorId}) failed:`, err.message);
    throw err;
  }
};

const getCategories = async () => {
  try {
    const response = await axios.get(`${CLOUDKART_API_URL}/api/categories`, {
      headers: headers(),
      timeout: 30000,
    });
    return response.data;
  } catch (err) {
    logger.error('getCategories failed:', err.message);
    throw err;
  }
};

// Backward-compatible alias
const getProducts = fetchProducts;

module.exports = { fetchProducts, fetchInventory, getProducts, getCategories };
