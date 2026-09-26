const express = require('express');
const { protect } = require('../middleware/auth');
const { requireNotSuspended } = require('../middleware/moderation');
const {
  createStory,
  getStoriesFeed,
  viewStory,
  getStoryViewers,
  deleteStory,
} = require('../controllers/storyController');

const router = express.Router();

router.get('/feed', protect, getStoriesFeed);
router.post('/', protect, requireNotSuspended, createStory);
router.post('/:storyId/view', protect, viewStory);
router.get('/:storyId/viewers', protect, getStoryViewers);
router.delete('/:storyId', protect, deleteStory);

module.exports = router;
