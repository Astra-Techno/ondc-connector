const express = require('express');
const router = express.Router();
const { createWebhook, getWebhooks, deleteWebhook } = require('../controllers/webhook.controller');
const { resolveTenant } = require('../middleware/tenant');

router.use(resolveTenant);
router.post('/', createWebhook);
router.get('/', getWebhooks);
router.delete('/:id', deleteWebhook);

module.exports = router;
