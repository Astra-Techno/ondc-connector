const express = require('express');
const router = express.Router();
const { getStats, getSyncLogs, getTransactions, getIgmFlows, getIgmFlow } = require('../controllers/dashboard.controller');
const { resolveTenant } = require('../middleware/tenant');

router.use(resolveTenant);
router.get('/stats',        getStats);
router.get('/sync-logs',    getSyncLogs);
router.get('/transactions', getTransactions);
router.get('/igm-flows',    getIgmFlows);
router.get('/igm-flow/:transaction_id', getIgmFlow);

module.exports = router;
