const express = require('express');
const userController = require('../controllers/userController');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.post('/init-admin', userController.initAdmin);
router.post('/register', userController.register);
router.post('/login', userController.login);

router.get('/profile', auth, userController.getProfile);
router.put('/profile', auth, userController.updateProfile);
router.put('/change-password', auth, userController.changePassword);

router.post('/deposit', auth, userController.deposit);
router.get('/transactions', auth, userController.getTransactions);

router.get('/notifications', auth, userController.getAllNotifications);
router.get('/notifications/unread', auth, userController.getUnreadNotifications);
router.put('/notifications/:id/read', auth, userController.markNotificationRead);
router.put('/notifications/read-all', auth, userController.markAllNotificationsRead);

router.get('/', auth, adminOnly, userController.getAllUsers);
router.get('/:id', auth, adminOnly, userController.getUserById);
router.put('/:id/status', auth, adminOnly, userController.updateUserStatus);
router.put('/:id/credit-score', auth, adminOnly, userController.adjustCreditScore);
router.put('/:id/restrict', auth, adminOnly, userController.setRentalRestriction);

module.exports = router;
