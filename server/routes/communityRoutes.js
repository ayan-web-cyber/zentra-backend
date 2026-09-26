const express = require('express');
const { body } = require('express-validator');
const { protect, optionalAuth } = require('../middleware/auth');
const validate = require('../middleware/validate');
const {
  listCommunities,
  createCommunity,
  getCommunity,
  updateCommunity,
  deleteCommunity,
  joinCommunity,
  leaveCommunity,
  listMembers,
  addModerator,
  removeModerator,
  removeMember,
  inviteMember,
  cancelInvite,
  listMyInvites,
  respondToInvite,
  getCommunityPosts,
  openCommunityChat,
} = require('../controllers/communityController');

const router = express.Router();

router.get('/', protect, listCommunities);
router.post('/', protect, [body('name').trim().notEmpty().withMessage('Community name is required')], validate, createCommunity);

// Must come before the '/:idOrSlug' catch-all below, or "invites" gets parsed as a slug.
router.get('/invites/mine', protect, listMyInvites);

router.get('/:idOrSlug', optionalAuth, getCommunity);
router.put('/:communityId', protect, updateCommunity);
router.delete('/:communityId', protect, deleteCommunity);

router.post('/:communityId/join', protect, joinCommunity);
router.post('/:communityId/leave', protect, leaveCommunity);
router.get('/:communityId/members', optionalAuth, listMembers);
router.delete('/:communityId/members/:userId', protect, removeMember);
router.post(
  '/:communityId/invite',
  protect,
  [body('userId').notEmpty().withMessage('userId is required')],
  validate,
  inviteMember
);
router.delete('/:communityId/invites/:userId', protect, cancelInvite);
router.post('/:communityId/invites/respond', protect, respondToInvite);
router.post('/:communityId/moderators/:userId', protect, addModerator);
router.delete('/:communityId/moderators/:userId', protect, removeModerator);

router.get('/:communityId/posts', optionalAuth, getCommunityPosts);
router.post('/:communityId/chat', protect, openCommunityChat);

module.exports = router;
