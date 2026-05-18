const express = require('express');
const router = express.Router();
const { syncCatalog, syncInventory, getProducts, getProduct, deleteProduct } = require('../controllers/catalog.controller');
const { resolveTenant } = require('../middleware/tenant');

router.use(resolveTenant);
router.post('/sync', syncCatalog);
router.post('/inventory', syncInventory);
router.get('/products', getProducts);
router.get('/products/:product_id', getProduct);
router.delete('/products/:product_id', deleteProduct);

module.exports = router;
