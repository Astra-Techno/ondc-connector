const express = require('express');
const router  = express.Router();
const { resolveTenant } = require('../middleware/tenant');
const {
  getSettlements,
  getSettlementById,
  processSettlement,
  getSettlementStats,
  generateSettlementReport,
} = require('../controllers/settlement.controller');

router.use(resolveTenant);
router.get('/',          getSettlements);
router.get('/stats',     getSettlementStats);
router.get('/report',    generateSettlementReport);
router.get('/:id',       getSettlementById);
router.post('/:id/process', processSettlement);

module.exports = router;
