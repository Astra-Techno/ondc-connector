const express = require('express');
const router = express.Router();
const { getStats, getSyncLogs } = require('../controllers/dashboard.controller');
const { resolveTenant } = require('../middleware/tenant');

router.use(resolveTenant);
router.get('/stats', getStats);
router.get('/sync-logs', getSyncLogs);

module.exports = router;
