const FriendRequest = require('../models/FriendRequest');
const User = require('../models/User');
const notify = require('../utils/notify');
const { ensureDirectConversation } = require('./conversationController');

// POST /api/friends/request/:username
exports.sendRequest = async (req, res) => {
  try {
    const to = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!to) return res.status(404).json({ success: false, message: 'User not found' });
    if (to._id.equals(req.user._id)) {
      return res.status(400).json({ success: false, message: "You can't friend yourself" });
    }

    const blocked =
      req.user.blockedUsers.some((b) => b.equals(to._id)) || to.blockedUsers.some((b) => b.equals(req.user._id));
    if (blocked) {
      return res.status(403).json({ success: false, message: 'You can no longer send a request to this user' });
    }

    const alreadyFriends = req.user.friends.some((f) => f.equals(to._id));
    if (alreadyFriends) {
      return res.status(409).json({ success: false, message: 'Already friends' });
    }

    const existing = await FriendRequest.findOne({
      $or: [
        { from: req.user._id, to: to._id },
        { from: to._id, to: req.user._id },
      ],
      status: 'pending',
    });
    if (existing) {
      return res.status(409).json({ success: false, message: 'A request is already pending' });
    }

    const request = await FriendRequest.create({ from: req.user._id, to: to._id });
    notify(req.app.get('io'), {
      recipient: to._id,
      actor: req.user._id,
      type: 'friendRequest',
      friendRequest: request._id,
    });
    return res.status(201).json({ success: true, request });
  } catch (err) {
    if (err.code === 11000) {
      // Two rapid clicks (or two tabs) both passed the pending-check above before either
      // insert landed — the partial unique index caught it, so just report it as pending.
      return res.status(409).json({ success: false, message: 'A request is already pending' });
    }
    console.error('[sendRequest]', err);
    return res.status(500).json({ success: false, message: 'Could not send friend request' });
  }
};

// DELETE /api/friends/request/:username — withdraw a request I sent, while it's still pending
exports.cancelRequest = async (req, res) => {
  try {
    const to = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!to) return res.status(404).json({ success: false, message: 'User not found' });

    const request = await FriendRequest.findOneAndDelete({ from: req.user._id, to: to._id, status: 'pending' });
    if (!request) return res.status(404).json({ success: false, message: 'No pending request to cancel' });

    return res.json({ success: true, message: 'Friend request cancelled' });
  } catch (err) {
    console.error('[cancelRequest]', err);
    return res.status(500).json({ success: false, message: 'Could not cancel request' });
  }
};

// POST /api/friends/:requestId/accept
exports.acceptRequest = async (req, res) => {
  try {
    const request = await FriendRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
    if (!request.to.equals(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (request.status !== 'pending') {
      return res.status(409).json({ success: false, message: 'Request already resolved' });
    }

    request.status = 'accepted';
    await request.save();

    // Accepting also makes them mutual followers, per spec — each side gains the other
    // in both their followers and following lists, not just the friends list.
    await Promise.all([
      User.findByIdAndUpdate(request.from, {
        $addToSet: { friends: request.to, following: request.to, followers: request.to },
      }),
      User.findByIdAndUpdate(request.to, {
        $addToSet: { friends: request.from, following: request.from, followers: request.from },
      }),
    ]);

    // New friends are automatically added to chat — a direct conversation now exists
    // between them so they show up in each other's Messages list right away, with no
    // "New message" search needed. Failure here shouldn't block the friend acceptance
    // itself, so it's logged rather than surfaced as an error to the person accepting.
    await ensureDirectConversation(request.from, request.to).catch((err) =>
      console.error('[acceptRequest] Could not auto-create conversation:', err.message)
    );

    notify(req.app.get('io'), { recipient: request.from, actor: req.user._id, type: 'friendAccept' });

    return res.json({ success: true, message: 'Friend request accepted' });
  } catch (err) {
    console.error('[acceptRequest]', err);
    return res.status(500).json({ success: false, message: 'Could not accept request' });
  }
};

// POST /api/friends/:requestId/reject
exports.rejectRequest = async (req, res) => {
  try {
    const request = await FriendRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
    if (!request.to.equals(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    request.status = 'rejected';
    await request.save();

    return res.json({ success: true, message: 'Friend request rejected' });
  } catch (err) {
    console.error('[rejectRequest]', err);
    return res.status(500).json({ success: false, message: 'Could not reject request' });
  }
};

// DELETE /api/friends/:username
exports.removeFriend = async (req, res) => {
  try {
    const other = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!other) return res.status(404).json({ success: false, message: 'User not found' });

    req.user.friends = req.user.friends.filter((f) => !f.equals(other._id));
    other.friends = other.friends.filter((f) => !f.equals(req.user._id));

    // Unfriending also breaks the mutual follow it created — both people drop out of
    // each other's followers AND following lists, not just the friends list.
    req.user.following = req.user.following.filter((f) => !f.equals(other._id));
    req.user.followers = req.user.followers.filter((f) => !f.equals(other._id));
    other.following = other.following.filter((f) => !f.equals(req.user._id));
    other.followers = other.followers.filter((f) => !f.equals(req.user._id));

    await Promise.all([req.user.save(), other.save()]);

    return res.json({ success: true, message: `Removed ${other.username} from friends` });
  } catch (err) {
    console.error('[removeFriend]', err);
    return res.status(500).json({ success: false, message: 'Could not remove friend' });
  }
};

// GET /api/friends/requests — pending requests sent to me
exports.listIncomingRequests = async (req, res) => {
  try {
    const requests = await FriendRequest.find({ to: req.user._id, status: 'pending' })
      .populate('from', 'name username avatarUrl')
      .sort('-createdAt');
    return res.json({ success: true, requests });
  } catch (err) {
    console.error('[listIncomingRequests]', err);
    return res.status(500).json({ success: false, message: 'Could not load requests' });
  }
};
