const express = require('express');
const router = express.Router();
const { registerTenant, getTenantInfo } = require('../controllers/tenant.controller');
const { resolveTenant } = require('../middleware/tenant');

router.post('/register', registerTenant);
router.get('/info', resolveTenant, getTenantInfo);

module.exports = router;
