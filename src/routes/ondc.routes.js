const express = require('express');
const router = express.Router();
const { handleSearch, handleConfirm, handleACK } = require('../controllers/ondc.controller');

router.post('/on_search', handleACK('on_search'));
router.post('/on_init', handleACK('on_init'));
router.post('/on_confirm', handleACK('on_confirm'));
router.post('/on_status', handleACK('on_status'));
router.post('/on_cancel', handleACK('on_cancel'));
router.post('/on_update', handleACK('on_update'));
router.post('/on_track', handleACK('on_track'));
router.post('/on_support', handleACK('on_support'));
router.post('/on_rating', handleACK('on_rating'));
router.post('/on_issue', handleACK('on_issue'));

module.exports = router;
