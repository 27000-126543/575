const express = require('express');
const damageController = require('../controllers/damageController');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/statistics', auth, adminOnly, damageController.getStatistics);
router.get('/overdue', auth, adminOnly, damageController.getOverdueReports);

router.get('/', auth, damageController.list);
router.get('/:id', auth, damageController.getById);

router.put('/:id/review', auth, adminOnly, damageController.review);
router.put('/:id/pay', auth, damageController.pay);
router.put('/:id/compensation', auth, adminOnly, damageController.updateCompensation);
router.put('/:id/start-review', auth, adminOnly, damageController.startReview);

module.exports = router;
