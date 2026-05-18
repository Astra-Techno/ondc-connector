const express = require('express');
const router = express.Router();
const { getOrders, getOrder, updateOrderStatus } = require('../controllers/order.controller');
const { resolveTenant } = require('../middleware/tenant');

router.use(resolveTenant);
router.get('/', getOrders);
router.get('/:order_id', getOrder);
router.put('/:order_id/status', updateOrderStatus);

module.exports = router;
