const express = require('express');
const { postNotification, getNotifications, markNotificationRead } = require('../controllers/notificationController');

const authenticate = require('../middleware/authMiddleware');
const router = express.Router();
const workflowNotifications = require('../controllers/providerNotificationsV2Controller');

// Notification logic controller aur services mein rahegi.
router.post('/', authenticate, postNotification);
router.get('/me', authenticate, workflowNotifications.listNotifications);
router.patch('/me/:notificationId/read', authenticate, workflowNotifications.markNotificationRead);
router.get('/:user_type/:user_id', authenticate, getNotifications);
router.patch('/:notification_id/read', authenticate, markNotificationRead);

module.exports = router;
