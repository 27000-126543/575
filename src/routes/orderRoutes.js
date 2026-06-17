const express = require('express');
const orderController = require('../controllers/orderController');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/mine', auth, orderController.getMyOrders);
router.get('/statistics', auth, adminOnly, orderController.getStatistics);

router.post('/', auth, orderController.create);
router.get('/', auth, orderController.list);
router.get('/:id', auth, orderController.getById);

router.put('/:id/pickup', auth, orderController.pickUp);
router.put('/:id/return', auth, orderController.returnTool);
router.put('/:id/cancel', auth, orderController.cancel);
router.put('/:id/reject', auth, adminOnly, orderController.rejectByAdmin);
router.put('/:id/force-complete', auth, adminOnly, orderController.forceComplete);

module.exports = router;
