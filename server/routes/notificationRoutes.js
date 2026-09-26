const express = require('express');
const { protect } = require('../middleware/auth');
const {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
  clearAll,
} = require('../controllers/notificationController');

const router = express.Router();

router.get('/', protect, listNotifications);
router.get('/unread-count', protect, getUnreadCount);
router.patch('/read-all', protect, markAllRead);
router.patch('/:id/read', protect, markRead);
router.delete('/:id', protect, deleteNotification);
router.delete('/', protect, clearAll);

module.exports = router;
