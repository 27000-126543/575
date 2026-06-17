const express = require('express');
const toolController = require('../controllers/toolController');
const { auth, adminOnly, optionalAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/category-stats', optionalAuth, toolController.getCategoryStats);
router.get('/:id/calculate-price', optionalAuth, toolController.calculatePrice);
router.post('/:id/calculate-price', optionalAuth, toolController.calculatePrice);
router.get('/:id/availability', optionalAuth, toolController.checkAvailability);

router.get('/', optionalAuth, toolController.list);
router.get('/:id', optionalAuth, toolController.getById);

router.post('/', auth, adminOnly, toolController.create);
router.post('/bulk', auth, adminOnly, toolController.bulkCreate);
router.put('/:id', auth, adminOnly, toolController.update);
router.delete('/:id', auth, adminOnly, toolController.remove);
router.put('/:id/stock', auth, adminOnly, toolController.updateStock);

module.exports = router;
