const axios = require('axios');
const logger = require('../../utils/logger');

const CLOUDKART_API_URL = process.env.CLOUDKART_API_URL;
const CLOUDKART_API_KEY = process.env.CLOUDKART_API_KEY;

const headers = () => ({
  'Content-Type': 'application/json',
  'X-API-Key': CLOUDKART_API_KEY,
});

const normalizeVendor = (v) => ({
  vendor_id:     String(v.id),
  business_name: v.business_name || v.name,
  gstin:         v.gstin         || '',
  phone:         v.phone         || '',
  email:         v.email         || '',
  address:       v.address       || '',
  city:          v.city          || '',
  state:         v.state         || '',
  pincode:       v.pincode       || '',
  gps:           v.gps           || '',
  logo_url:      v.logo_url      || '',
  ondc_eligible: v.ondc_eligible !== false,
});

const fetchVendors = async (page = 1, limit = 50) => {
  try {
    const response = await axios.get(`${CLOUDKART_API_URL}/api/vendors`, {
      params: { page, limit },
      headers: headers(),
      timeout: 30000,
    });
    const data = response.data?.data || response.data || [];
    return (Array.isArray(data) ? data : data.items || []).map(normalizeVendor);
  } catch (err) {
    logger.error('fetchVendors failed:', err.message);
    throw err;
  }
};

const fetchVendorById = async (vendorId) => {
  try {
    const response = await axios.get(`${CLOUDKART_API_URL}/api/vendors/${vendorId}`, {
      headers: headers(),
      timeout: 30000,
    });
    const v = response.data?.data || response.data;
    return normalizeVendor(v);
  } catch (err) {
    logger.error(`fetchVendorById(${vendorId}) failed:`, err.message);
    throw err;
  }
};

module.exports = { fetchVendors, fetchVendorById };
