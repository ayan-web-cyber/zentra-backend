const User = require('../models/User');
const FriendRequest = require('../models/FriendRequest');
const { saveBufferToGridFS } = require('./mediaController');
const notify = require('../utils/notify');

const PUBLIC_FIELDS =
  'name username avatarUrl coverUrl bio followers following friends isPrivate createdAt isOnline lastSeen';

// GET /api/users?q=ay — used by the @mention autocomplete and the "tag people" picker
exports.searchUsers = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ success: true, users: [] });

    const regex = new RegExp('^' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await User.find({
      $or: [{ username: regex }, { name: regex }],
      _id: { $ne: req.user?._id },
    })
      .select('name username avatarUrl')
      .limit(8);

    return res.json({ success: true, users });
  } catch (err) {
    console.error('[searchUsers]', err);
    return res.status(500).json({ success: false, message: 'Search failed' });
  }
};

// GET /api/users/:username
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username.toLowerCase() }).select(PUBLIC_FIELDS);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const viewerId = req.user?._id?.toString();
    const isSelf = viewerId === user._id.toString();
    const isFollowing = viewerId ? user.followers.some((f) => f.toString() === viewerId) : false;
    const isFriend = viewerId ? user.friends.some((f) => f.toString() === viewerId) : false;

    // Friend-request state has to come from the database, not be assumed client-side —
    // otherwise the "Add friend" button forgets a request was ever sent on every reload,
    // and a second click just throws an unhandled duplicate-request error.
    let friendRequestStatus = 'none';
    let friendRequestId = null;
    if (viewerId && !isSelf && !isFriend) {
      const pending = await FriendRequest.findOne({
        $or: [
          { from: req.user._id, to: user._id },
          { from: user._id, to: req.user._id },
        ],
        status: 'pending',
      });
      if (pending) {
        friendRequestId = pending._id;
        friendRequestStatus = String(pending.from) === viewerId ? 'pending_sent' : 'pending_received';
      }
    }

    return res.json({
      success: true,
      user: {
        ...user.toObject(),
        followerCount: user.followers.filter((f) => !f.equals(user._id)).length,
        followingCount: user.following.filter((f) => !f.equals(user._id)).length,
        friendCount: user.friends.length,
        isSelf,
        isFollowing,
        isFriend,
        friendRequestStatus,
        friendRequestId,
        isBlockedByViewer: viewerId ? req.user.blockedUsers.some((b) => b.equals(user._id)) : false,
        isMutedByViewer: viewerId ? (req.user.mutedUsers || []).some((m) => m.equals(user._id)) : false,
        // A private account still returns its identity (name, avatar, bio, counts) so the
        // profile is findable and followable — but the caller must check this before
        // rendering any of the account's actual content. getUserPosts enforces the same
        // rule server-side, so this flag is for UI honesty, not the security boundary.
        isContentLocked: !isSelf && user.isPrivate && !isFollowing && !isFriend,
      },
    });
  } catch (err) {
    console.error('[getProfile]', err);
    return res.status(500).json({ success: false, message: 'Could not load profile' });
  }
};

// PUT /api/users/me
exports.updateProfile = async (req, res) => {
  try {
    const { name, bio, isPrivate } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (bio !== undefined) updates.bio = bio;
    if (isPrivate !== undefined) updates.isPrivate = isPrivate;

    const user = await User.findByIdAndUpdate(req.user._id, updates, {
      new: true,
      runValidators: true,
    });

    return res.json({ success: true, user: user.toSafeObject() });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('[updateProfile]', err);
    return res.status(500).json({ success: false, message: 'Update failed' });
  }
};

// PUT /api/users/me/privacy
exports.updatePrivacy = async (req, res) => {
  try {
    const { posts, messages, calls, stories } = req.body;
    const user = await User.findById(req.user._id);

    if (posts) user.privacy.posts = posts;
    if (messages) user.privacy.messages = messages;
    if (calls) user.privacy.calls = calls;
    if (stories) user.privacy.stories = stories;

    await user.save();
    return res.json({ success: true, privacy: user.privacy });
  } catch (err) {
    console.error('[updatePrivacy]', err);
    return res.status(500).json({ success: false, message: 'Update failed' });
  }
};

// GET /api/users/me/blocked — populated list for the Settings > Blocked users screen
exports.listBlockedUsers = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('blockedUsers', 'name username avatarUrl');
    return res.json({ success: true, users: user.blockedUsers });
  } catch (err) {
    console.error('[listBlockedUsers]', err);
    return res.status(500).json({ success: false, message: 'Could not load blocked users' });
  }
};

// POST /api/users/me/deactivate — section 40: account deactivation (not a hard delete)
exports.deactivateAccount = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { isDeactivated: true, isOnline: false });
    res.clearCookie(process.env.JWT_COOKIE_NAME || 'cs_token');
    return res.json({ success: true, message: 'Account deactivated' });
  } catch (err) {
    console.error('[deactivateAccount]', err);
    return res.status(500).json({ success: false, message: 'Could not deactivate account' });
  }
};

// PUT /api/users/me/theme
exports.updateTheme = async (req, res) => {
  try {
    const { theme } = req.body;
    if (!['light', 'dark', 'system'].includes(theme)) {
      return res.status(400).json({ success: false, message: 'Invalid theme' });
    }
    await User.findByIdAndUpdate(req.user._id, { themePreference: theme });
    return res.json({ success: true, theme });
  } catch (err) {
    console.error('[updateTheme]', err);
    return res.status(500).json({ success: false, message: 'Could not update theme' });
  }
};

// POST /api/users/me/avatar  (multipart, field "file")
exports.uploadAvatar = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });

    const media = await saveBufferToGridFS({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      ownerId: req.user._id,
      kind: 'avatar',
    });

    req.user.avatarUrl = media.toUrl();
    await req.user.save();

    return res.json({ success: true, avatarUrl: media.toUrl() });
  } catch (err) {
    console.error('[uploadAvatar]', err);
    return res.status(500).json({ success: false, message: 'Avatar upload failed' });
  }
};

// POST /api/users/me/cover  (multipart, field "file")
exports.uploadCover = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });

    const media = await saveBufferToGridFS({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      ownerId: req.user._id,
      kind: 'cover',
    });

    req.user.coverUrl = media.toUrl();
    await req.user.save();

    return res.json({ success: true, coverUrl: media.toUrl() });
  } catch (err) {
    console.error('[uploadCover]', err);
    return res.status(500).json({ success: false, message: 'Cover upload failed' });
  }
};

// POST /api/users/:username/block
exports.blockUser = async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (target._id.equals(req.user._id)) {
      return res.status(400).json({ success: false, message: "You can't block yourself" });
    }

    if (!req.user.blockedUsers.some((b) => b.equals(target._id))) {
      req.user.blockedUsers.push(target._id);
      await req.user.save();
    }

    return res.json({ success: true, message: `Blocked ${target.name}` });
  } catch (err) {
    console.error('[blockUser]', err);
    return res.status(500).json({ success: false, message: 'Could not block user' });
  }
};

// POST /api/users/:username/unblock
exports.unblockUser = async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });

    req.user.blockedUsers = req.user.blockedUsers.filter((b) => !b.equals(target._id));
    await req.user.save();

    return res.json({ success: true, message: `Unblocked ${target.name}` });
  } catch (err) {
    console.error('[unblockUser]', err);
    return res.status(500).json({ success: false, message: 'Could not unblock user' });
  }
};

// POST /api/users/:username/follow
exports.followUser = async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (target._id.equals(req.user._id)) {
      return res.status(400).json({ success: false, message: "You can't follow yourself" });
    }

    const alreadyFollowing = target.followers.some((f) => f.equals(req.user._id));
    if (alreadyFollowing) {
      return res.status(409).json({ success: false, message: 'Already following this user' });
    }

    target.followers.push(req.user._id);
    req.user.following.push(target._id);
    await Promise.all([target.save(), req.user.save()]);

    notify(req.app.get('io'), { recipient: target._id, actor: req.user._id, type: 'follow' });

    return res.json({ success: true, message: `Following ${target.username}` });
  } catch (err) {
    console.error('[followUser]', err);
    return res.status(500).json({ success: false, message: 'Follow failed' });
  }
};

// POST /api/users/:username/unfollow
exports.unfollowUser = async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });

    target.followers = target.followers.filter((f) => !f.equals(req.user._id));
    req.user.following = req.user.following.filter((f) => !f.equals(target._id));
    await Promise.all([target.save(), req.user.save()]);

    return res.json({ success: true, message: `Unfollowed ${target.username}` });
  } catch (err) {
    console.error('[unfollowUser]', err);
    return res.status(500).json({ success: false, message: 'Unfollow failed' });
  }
};

// GET /api/users/:username/followers — people who follow this user
exports.listFollowers = async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username.toLowerCase() }).populate(
      'followers',
      'name username avatarUrl isOnline'
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const viewerId = req.user?._id?.toString();
    const viewerFollowing = viewerId
      ? (await User.findById(viewerId).select('following')).following.map((f) => f.toString())
      : [];

    const followers = user.followers
      .filter((f) => !f._id.equals(user._id)) // guard against stale self-follow data
      .map((f) => ({
        ...f.toObject(),
        isFollowedByViewer: viewerId ? viewerFollowing.includes(f._id.toString()) : false,
        isViewer: viewerId === f._id.toString(),
      }));

    return res.json({ success: true, followers });
  } catch (err) {
    console.error('[listFollowers]', err);
    return res.status(500).json({ success: false, message: 'Could not load followers list' });
  }
};

// GET /api/users/:username/following — people this user follows
exports.listFollowing = async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username.toLowerCase() }).populate(
      'following',
      'name username avatarUrl isOnline'
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const viewerId = req.user?._id?.toString();
    const viewerFollowing = viewerId
      ? (await User.findById(viewerId).select('following')).following.map((f) => f.toString())
      : [];

    const following = user.following
      .filter((f) => !f._id.equals(user._id)) // guard against stale self-follow data
      .map((f) => ({
        ...f.toObject(),
        isFollowedByViewer: viewerId ? viewerFollowing.includes(f._id.toString()) : false,
        isViewer: viewerId === f._id.toString(),
      }));

    return res.json({ success: true, following });
  } catch (err) {
    console.error('[listFollowing]', err);
    return res.status(500).json({ success: false, message: 'Could not load following list' });
  }
};

// GET /api/users/:username/friends — that user's friends list
exports.listFriends = async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username.toLowerCase() }).populate(
      'friends',
      'name username avatarUrl isOnline'
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    return res.json({ success: true, friends: user.friends });
  } catch (err) {
    console.error('[listFriends]', err);
    return res.status(500).json({ success: false, message: 'Could not load friends list' });
  }
};

// POST /api/users/:username/mute — silent, one-directional; the muted person isn't told
// and loses no access, their content just stops appearing in this viewer's feed/stories.
exports.muteUser = async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (target._id.equals(req.user._id)) {
      return res.status(400).json({ success: false, message: "You can't mute yourself" });
    }

    await User.findByIdAndUpdate(req.user._id, { $addToSet: { mutedUsers: target._id } });
    return res.json({ success: true, message: `Muted ${target.name}` });
  } catch (err) {
    console.error('[muteUser]', err);
    return res.status(500).json({ success: false, message: 'Could not mute user' });
  }
};

// POST /api/users/:username/unmute
exports.unmuteUser = async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });

    await User.findByIdAndUpdate(req.user._id, { $pull: { mutedUsers: target._id } });
    return res.json({ success: true, message: `Unmuted ${target.name}` });
  } catch (err) {
    console.error('[unmuteUser]', err);
    return res.status(500).json({ success: false, message: 'Could not unmute user' });
  }
};

// GET /api/users/me/muted
exports.listMutedUsers = async (req, res) => {
  try {
    const me = await User.findById(req.user._id).populate('mutedUsers', 'name username avatarUrl');
    return res.json({ success: true, users: me.mutedUsers });
  } catch (err) {
    console.error('[listMutedUsers]', err);
    return res.status(500).json({ success: false, message: 'Could not load muted users' });
  }
};

// POST /api/users/:username/close-friend — backs the 'closeFriends' story privacy option
exports.addCloseFriend = async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (target._id.equals(req.user._id)) {
      return res.status(400).json({ success: false, message: "You can't add yourself" });
    }

    await User.findByIdAndUpdate(req.user._id, { $addToSet: { closeFriends: target._id } });
    return res.json({ success: true, message: `Added ${target.name} to close friends` });
  } catch (err) {
    console.error('[addCloseFriend]', err);
    return res.status(500).json({ success: false, message: 'Could not add close friend' });
  }
};

// DELETE /api/users/:username/close-friend
exports.removeCloseFriend = async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });

    await User.findByIdAndUpdate(req.user._id, { $pull: { closeFriends: target._id } });
    return res.json({ success: true, message: `Removed ${target.name} from close friends` });
  } catch (err) {
    console.error('[removeCloseFriend]', err);
    return res.status(500).json({ success: false, message: 'Could not remove close friend' });
  }
};

// GET /api/users/me/close-friends
exports.listCloseFriends = async (req, res) => {
  try {
    const me = await User.findById(req.user._id).populate('closeFriends', 'name username avatarUrl');
    return res.json({ success: true, users: me.closeFriends });
  } catch (err) {
    console.error('[listCloseFriends]', err);
    return res.status(500).json({ success: false, message: 'Could not load close friends' });
  }
};

// DELETE /api/users/me — permanent account deletion (section 40). Distinct from
// deactivation: this scrubs the account rather than just hiding it.
exports.deleteAccount = async (req, res) => {
  try {
    const userId = req.user._id;

    // Remove this user from everyone else's relationship lists so no dangling refs remain.
    await User.updateMany(
      {},
      {
        $pull: {
          followers: userId,
          following: userId,
          friends: userId,
          blockedUsers: userId,
          mutedUsers: userId,
          closeFriends: userId,
        },
      }
    );

    // Anonymize rather than hard-delete the account row: threads, conversations and
    // moderation history stay coherent instead of collapsing into broken references.
    const anonSuffix = String(userId).slice(-6);
    await User.findByIdAndUpdate(userId, {
      name: 'Deleted user',
      username: `deleted_${anonSuffix}`,
      email: `deleted_${anonSuffix}@deleted.invalid`,
      bio: '',
      avatarUrl: '',
      coverUrl: '',
      isDeactivated: true,
      followers: [],
      following: [],
      friends: [],
      blockedUsers: [],
      mutedUsers: [],
      closeFriends: [],
    });

    res.clearCookie(process.env.JWT_COOKIE_NAME || 'cs_token');
    return res.json({ success: true, message: 'Account deleted' });
  } catch (err) {
    console.error('[deleteAccount]', err);
    return res.status(500).json({ success: false, message: 'Could not delete account' });
  }
};
