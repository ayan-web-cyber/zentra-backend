const express = require('express');
const { protect } = require('../middleware/auth');
const { deleteComment, likeComment } = require('../controllers/commentController');

const router = express.Router();

router.delete('/:commentId', protect, deleteComment);
router.post('/:commentId/like', protect, likeComment);

module.exports = router;
