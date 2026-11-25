const express = require('express');
const router  = express.Router();
const { resolveTenant } = require('../middleware/tenant');
const { getIssues, getIssue, getRawPayload, updateIssue, backfillIssues, diagTable } = require('../controllers/igm.controller');

router.use(resolveTenant);
router.get('/',              getIssues);
router.post('/backfill',     backfillIssues);
router.get('/diag',          diagTable);
router.get('/:id',           getIssue);
router.get('/:id/raw',       getRawPayload);
router.put('/:id',           updateIssue);

module.exports = router;
