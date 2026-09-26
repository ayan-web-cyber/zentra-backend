const express = require('express');
const { body } = require('express-validator');
const { protect, optionalAuth } = require('../middleware/auth');
const { requireNotSuspended } = require('../middleware/moderation');
const validate = require('../middleware/validate');
const {
  createPost,
  getFeed,
  getPost,
  getUserPosts,
  updatePost,
  deletePost,
  likePost,
  unlikePost,
  sharePost,
  sharePostToConversations,
  savePost,
  unsavePost,
  getSavedPosts,
  hidePost,
  unhidePost,
  votePoll,
  getReelsFeed,
} = require('../controllers/postController');
const { listComments, addComment } = require('../controllers/commentController');

const router = express.Router();

router.get('/feed', protect, getFeed);
router.get('/saved', protect, getSavedPosts);
router.get('/reels/feed', optionalAuth, getReelsFeed);
router.get('/user/:username', optionalAuth, getUserPosts);

router.post(
  '/',
  protect,
  requireNotSuspended,
  [
    body('type').isIn(['text', 'photo', 'video', 'multiPhoto', 'poll', 'voice', 'music']),
    body('caption').optional().isLength({ max: 2000 }),
  ],
  validate,
  createPost
);

router.get('/:postId', optionalAuth, getPost);
router.put('/:postId', protect, updatePost);
router.delete('/:postId', protect, deletePost);

router.post('/:postId/like', protect, likePost);
router.delete('/:postId/like', protect, unlikePost);
router.post('/:postId/share', protect, sharePost);
router.post('/:postId/share-to', protect, sharePostToConversations);
router.post('/:postId/save', protect, savePost);
router.delete('/:postId/save', protect, unsavePost);
router.post('/:postId/hide', protect, hidePost);
router.delete('/:postId/hide', protect, unhidePost);
router.post('/:postId/vote', protect, votePoll);

router.get('/:postId/comments', optionalAuth, listComments);
router.post('/:postId/comments', protect, requireNotSuspended, [body('text').trim().notEmpty()], validate, addComment);

module.exports = router;
