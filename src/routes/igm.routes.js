const express = require('express');
const router  = express.Router();
const { resolveTenant } = require('../middleware/tenant');
const { getIssues, getIssue, updateIssue } = require('../controllers/igm.controller');

router.use(resolveTenant);
router.get('/',    getIssues);
router.get('/:id', getIssue);
router.put('/:id', updateIssue);

module.exports = router;
