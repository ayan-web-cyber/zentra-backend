const express = require('express');
const { protect } = require('../middleware/auth');
const { editMessage, deleteMessage, reactToMessage, forwardMessage } = require('../controllers/messageController');

const router = express.Router();

router.put('/:messageId', protect, editMessage);
router.delete('/:messageId', protect, deleteMessage);
router.post('/:messageId/react', protect, reactToMessage);
router.post('/:messageId/forward', protect, forwardMessage);

module.exports = router;
