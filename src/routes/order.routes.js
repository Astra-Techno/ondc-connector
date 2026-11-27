const express = require('express');
const router = express.Router();
const { getOrders, getOrder, getOrderTimeline, getOrderLogs, updateOrderStatus } = require('../controllers/order.controller');
const { resolveTenant } = require('../middleware/tenant');

router.use(resolveTenant);
router.get('/', getOrders);
router.get('/:order_id', getOrder);
router.get('/:order_id/timeline', getOrderTimeline);
router.get('/:order_id/logs', getOrderLogs);
router.put('/:order_id/status', updateOrderStatus);
router.put('/:order_id/workflow', require('../controllers/ondc.controller').setWorkflowProfile);

module.exports = router;
