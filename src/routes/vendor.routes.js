const express = require('express');
const router = express.Router();
const { syncVendors, getVendors, getVendor, updateVendor } = require('../controllers/vendor.controller');
const { resolveTenant } = require('../middleware/tenant');

router.use(resolveTenant);
router.post('/sync', syncVendors);
router.get('/', getVendors);
router.get('/:vendor_id', getVendor);
router.put('/:vendor_id', updateVendor);

module.exports = router;
