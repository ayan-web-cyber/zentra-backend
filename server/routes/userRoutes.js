const express = require('express');
const { body } = require('express-validator');
const { protect, optionalAuth } = require('../middleware/auth');
const validate = require('../middleware/validate');
const upload = require('../middleware/upload');
const {
  getProfile,
  updateProfile,
  updatePrivacy,
  uploadAvatar,
  uploadCover,
  followUser,
  unfollowUser,
  blockUser,
  unblockUser,
  searchUsers,
  listBlockedUsers,
  deactivateAccount,
  updateTheme,
  listFriends,
  listFollowers,
  listFollowing,
  muteUser,
  unmuteUser,
  listMutedUsers,
  addCloseFriend,
  removeCloseFriend,
  listCloseFriends,
  deleteAccount,
} = require('../controllers/userController');

const router = express.Router();

router.get('/', optionalAuth, searchUsers);

router.put(
  '/me',
  protect,
  [
    body('name').optional().trim().isLength({ min: 1, max: 50 }),
    body('bio').optional().trim().isLength({ max: 160 }),
    body('isPrivate').optional().isBoolean(),
  ],
  validate,
  updateProfile
);

router.put('/me/privacy', protect, updatePrivacy);
router.put('/me/theme', protect, updateTheme);
router.get('/me/blocked', protect, listBlockedUsers);
router.get('/me/muted', protect, listMutedUsers);
router.get('/me/close-friends', protect, listCloseFriends);
router.post('/me/deactivate', protect, deactivateAccount);
router.delete('/me', protect, deleteAccount);
router.post('/me/avatar', protect, upload.single('file'), uploadAvatar);
router.post('/me/cover', protect, upload.single('file'), uploadCover);

router.get('/:username', optionalAuth, getProfile);
router.get('/:username/friends', optionalAuth, listFriends);
router.get('/:username/followers', optionalAuth, listFollowers);
router.get('/:username/following', optionalAuth, listFollowing);
router.post('/:username/follow', protect, followUser);
router.post('/:username/unfollow', protect, unfollowUser);
router.post('/:username/block', protect, blockUser);
router.post('/:username/unblock', protect, unblockUser);
router.post('/:username/mute', protect, muteUser);
router.post('/:username/unmute', protect, unmuteUser);
router.post('/:username/close-friend', protect, addCloseFriend);
router.delete('/:username/close-friend', protect, removeCloseFriend);

module.exports = router;
