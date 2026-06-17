const express = require('express');
const reportController = require('../controllers/reportController');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/dashboard', auth, adminOnly, reportController.getDashboard);
router.get('/export', auth, adminOnly, reportController.exportExcel);
router.get('/summary', auth, adminOnly, reportController.getSummary);
router.get('/date/:date', auth, adminOnly, reportController.getByDate);
router.get('/', auth, adminOnly, reportController.list);

router.post('/generate-today', auth, adminOnly, reportController.generateToday);
router.post('/generate-custom', auth, adminOnly, reportController.generateCustom);
router.post('/run-tasks', auth, adminOnly, reportController.runScheduledTasks);

module.exports = router;
