const express = require('express');
const { protect } = require('../middleware/auth');
const {
  listConversations,
  startDirectConversation,
  createGroup,
  addMember,
  removeMember,
  leaveConversation,
  toggleMute,
  setTheme,
  clearChat,
} = require('../controllers/conversationController');
const { getMessages, markConversationRead, searchMessages } = require('../controllers/messageController');

const router = express.Router();

router.get('/', protect, listConversations);
router.post('/direct/:username', protect, startDirectConversation);
router.post('/group', protect, createGroup);
router.post('/:id/members', protect, addMember);
router.delete('/:id/members/:userId', protect, removeMember);
router.post('/:id/leave', protect, leaveConversation);
router.get('/:id/messages', protect, getMessages);
router.get('/:id/messages/search', protect, searchMessages);
router.post('/:id/read', protect, markConversationRead);
router.post('/:id/mute', protect, toggleMute);
router.patch('/:id/theme', protect, setTheme);
router.post('/:id/clear', protect, clearChat);

module.exports = router;
