const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');

function canMessage(target, senderId) {
  switch (target.privacy.messages) {
    case 'everyone':
      return true;
    case 'followers':
      return target.followers.some((f) => String(f) === String(senderId));
    case 'friends':
      return target.friends.some((f) => String(f) === String(senderId));
    case 'nobody':
      return false;
    default:
      return true;
  }
}

// True if either user has blocked the other — checked in both directions since
// blocking is only ever recorded on the blocker's own document.
function isBlockedPair(a, b) {
  if (!a || !b) return false;
  const aBlockedB = (a.blockedUsers || []).some((id) => String(id) === String(b._id));
  const bBlockedA = (b.blockedUsers || []).some((id) => String(id) === String(a._id));
  return aBlockedB || bBlockedA;
}

// viewer is the full req.user document (so we have viewer.blockedUsers to compare in both directions).
function serializeConversation(convo, viewer) {
  const obj = convo.toObject();
  const viewerId = viewer._id;
  const mutedByMe = (obj.mutedBy || []).some((id) => String(id) === String(viewerId));
  const otherParticipant = !obj.isGroup
    ? obj.participants.find((p) => String(p._id) !== String(viewerId))
    : null;

  const iBlockedThem = otherParticipant
    ? (viewer.blockedUsers || []).some((id) => String(id) === String(otherParticipant._id))
    : false;
  const theyBlockedMe = otherParticipant
    ? (otherParticipant.blockedUsers || []).some((id) => String(id) === String(viewerId))
    : false;

  return {
    ...obj,
    participants: obj.participants
      .filter((p) => String(p._id) !== String(viewerId))
      // blockedUsers is only fetched internally to compute the flags above — never leak it to the client.
      .map(({ blockedUsers, ...p }) => p),
    mutedBy: undefined,
    clearedBy: undefined,
    mutedByMe,
    iBlockedThem,
    theyBlockedMe,
  };
}

// GET /api/conversations — list, most recently active first, hidden ones (left by me) excluded
exports.listConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user._id,
      leftBy: { $ne: req.user._id },
    })
      .sort('-updatedAt')
      .populate('participants', 'name username avatarUrl isOnline lastSeen blockedUsers');

    return res.json({ success: true, conversations: conversations.map((c) => serializeConversation(c, req.user)) });
  } catch (err) {
    console.error('[listConversations]', err);
    return res.status(500).json({ success: false, message: 'Could not load conversations' });
  }
};

// POST /api/conversations/direct/:username — find-or-create a 1:1 conversation
// Find-or-create the 1:1 conversation between two users. Shared by the REST endpoint below
// and by friendController's acceptRequest, which auto-creates the chat so newly-friended
// people immediately show up in each other's Messages list without a manual "New message".
async function ensureDirectConversation(userIdA, userIdB) {
  let convo = await Conversation.findOne({
    isGroup: false,
    participants: { $all: [userIdA, userIdB], $size: 2 },
  });

  if (!convo) {
    convo = await Conversation.create({ participants: [userIdA, userIdB], isGroup: false });
  } else if (convo.leftBy.length) {
    convo.leftBy = [];
    await convo.save();
  }

  return convo;
}

exports.startDirectConversation = async (req, res) => {
  try {
    const other = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!other) return res.status(404).json({ success: false, message: 'User not found' });
    if (other._id.equals(req.user._id)) {
      return res.status(400).json({ success: false, message: "You can't message yourself" });
    }
    // Was inverted before: it let a blocked user right through. A message is refused if
    // the recipient's privacy setting disallows it, OR either side has blocked the other.
    if (isBlockedPair(req.user, other)) {
      return res.status(403).json({ success: false, message: 'You can’t message this user' });
    }
    if (!canMessage(other, req.user._id)) {
      return res.status(403).json({ success: false, message: `${other.name} isn't accepting messages from you` });
    }

    const convo = await ensureDirectConversation(req.user._id, other._id);

    const populated = await Conversation.findById(convo._id).populate(
      'participants',
      'name username avatarUrl isOnline lastSeen blockedUsers'
    );
    return res.json({ success: true, conversation: serializeConversation(populated, req.user) });
  } catch (err) {
    console.error('[startDirectConversation]', err);
    return res.status(500).json({ success: false, message: 'Could not start conversation' });
  }
};

// POST /api/conversations/group  { groupName, memberUsernames: [] }
exports.createGroup = async (req, res) => {
  try {
    const { groupName, memberUsernames } = req.body;
    if (!groupName?.trim()) return res.status(400).json({ success: false, message: 'Group name is required' });

    const requested = [...new Set((memberUsernames || []).map((u) => String(u).toLowerCase()))].filter(
      (u) => u !== req.user.username
    );
    const members = await User.find({ username: { $in: requested }, isDeactivated: { $ne: true } });

    // Blocking has to hold here too, or a group becomes a trivial way around it: you could
    // simply add someone who blocked you and message them anyway. Refuse rather than
    // silently dropping them, so the creator knows who didn't make it in.
    const blocked = members.filter((m) => isBlockedPair(req.user, m));
    if (blocked.length) {
      return res.status(403).json({
        success: false,
        message: `You can’t add ${blocked.map((b) => b.name).join(', ')} to a group`,
      });
    }

    const participantIds = [req.user._id, ...members.map((m) => m._id)];

    if (participantIds.length < 3) {
      return res.status(400).json({ success: false, message: 'A group needs at least 2 other members' });
    }

    const convo = await Conversation.create({
      participants: participantIds,
      isGroup: true,
      groupName: groupName.trim(),
      admins: [req.user._id],
    });

    const populated = await Conversation.findById(convo._id).populate(
      'participants',
      'name username avatarUrl isOnline lastSeen blockedUsers'
    );

    // Serialized once PER MEMBER, not once for everyone: serializeConversation strips the
    // viewer themself out of `participants`, so a single shared payload would show every
    // other member a participant list that includes themselves and omits the creator.
    const io = req.app.get('io');
    members.forEach((m) => {
      io?.to(`user:${m._id}`).emit('conversation:new', { conversation: serializeConversation(populated, m) });
    });

    return res.status(201).json({ success: true, conversation: serializeConversation(populated, req.user) });
  } catch (err) {
    console.error('[createGroup]', err);
    return res.status(500).json({ success: false, message: 'Could not create group' });
  }
};

// POST /api/conversations/:id/members  { username }  — admin only
exports.addMember = async (req, res) => {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo || !convo.isGroup) return res.status(404).json({ success: false, message: 'Group not found' });
    if (!convo.admins.some((a) => a.equals(req.user._id))) {
      return res.status(403).json({ success: false, message: 'Only admins can add members' });
    }

    const user = await User.findOne({ username: String(req.body.username || '').toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (isBlockedPair(req.user, user)) {
      return res.status(403).json({ success: false, message: `You can’t add ${user.name} to a group` });
    }

    if (!convo.participants.some((p) => p.equals(user._id))) {
      convo.participants.push(user._id);
      convo.leftBy = convo.leftBy.filter((id) => !id.equals(user._id));
      await convo.save();

      const populated = await Conversation.findById(convo._id).populate(
        'participants',
        'name username avatarUrl isOnline lastSeen blockedUsers'
      );
      req.app
        .get('io')
        ?.to(`user:${user._id}`)
        .emit('conversation:new', { conversation: serializeConversation(populated, user) });
    }

    return res.json({ success: true, message: `${user.name} added to the group` });
  } catch (err) {
    console.error('[addMember]', err);
    return res.status(500).json({ success: false, message: 'Could not add member' });
  }
};

// DELETE /api/conversations/:id/members/:userId — admin removes someone, or a member removes themself
exports.removeMember = async (req, res) => {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo || !convo.isGroup) return res.status(404).json({ success: false, message: 'Group not found' });

    const isSelf = req.params.userId === String(req.user._id);
    const isAdmin = convo.admins.some((a) => a.equals(req.user._id));
    if (!isSelf && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Only admins can remove other members' });
    }

    convo.participants = convo.participants.filter((p) => String(p) !== req.params.userId);
    convo.admins = convo.admins.filter((a) => String(a) !== req.params.userId);
    await convo.save();

    return res.json({ success: true, message: 'Member removed' });
  } catch (err) {
    console.error('[removeMember]', err);
    return res.status(500).json({ success: false, message: 'Could not remove member' });
  }
};

// POST /api/conversations/:id/leave
// For a real standalone group, this removes the caller as a participant (they're actually
// leaving the group). For a community's auto-created group chat, leaving/deleting the CHAT
// must NOT remove the caller from the community itself (that's community/leave, a separate
// action) — so it only hides the chat from their list, the same way a 1:1 "delete chat" does,
// and they stay a full participant so it's still in sync if they open the chat again later.
exports.leaveConversation = async (req, res) => {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ success: false, message: 'Conversation not found' });

    if (convo.community) {
      convo.leftBy.addToSet(req.user._id);
      await convo.save();
      return res.json({ success: true, message: 'Chat removed from your list' });
    }

    if (convo.isGroup) {
      convo.participants = convo.participants.filter((p) => !p.equals(req.user._id));
      convo.admins = convo.admins.filter((a) => !a.equals(req.user._id));
    } else {
      convo.leftBy.addToSet(req.user._id);
    }
    await convo.save();

    return res.json({ success: true, message: 'Left the conversation' });
  } catch (err) {
    console.error('[leaveConversation]', err);
    return res.status(500).json({ success: false, message: 'Could not leave conversation' });
  }
};

// POST /api/conversations/:id/mute — toggles mute for the requesting user only
exports.toggleMute = async (req, res) => {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ success: false, message: 'Conversation not found' });
    if (!convo.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(403).json({ success: false, message: 'Not a participant' });
    }

    const alreadyMuted = convo.mutedBy.some((id) => String(id) === String(req.user._id));
    if (alreadyMuted) {
      convo.mutedBy = convo.mutedBy.filter((id) => String(id) !== String(req.user._id));
    } else {
      convo.mutedBy.push(req.user._id);
    }
    await convo.save();

    return res.json({ success: true, mutedByMe: !alreadyMuted });
  } catch (err) {
    console.error('[toggleMute]', err);
    return res.status(500).json({ success: false, message: 'Could not update mute setting' });
  }
};

// PATCH /api/conversations/:id/theme  { theme }
const VALID_THEMES = ['aurora', 'sunset', 'ocean', 'forest', 'candy'];
exports.setTheme = async (req, res) => {
  try {
    const { theme } = req.body;
    if (!VALID_THEMES.includes(theme)) {
      return res.status(400).json({ success: false, message: 'Unknown theme' });
    }

    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ success: false, message: 'Conversation not found' });
    if (!convo.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(403).json({ success: false, message: 'Not a participant' });
    }

    convo.theme = theme;
    await convo.save();

    return res.json({ success: true, theme });
  } catch (err) {
    console.error('[setTheme]', err);
    return res.status(500).json({ success: false, message: 'Could not update theme' });
  }
};

// POST /api/conversations/:id/clear — hides history before now for the requesting user only
exports.clearChat = async (req, res) => {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ success: false, message: 'Conversation not found' });
    if (!convo.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(403).json({ success: false, message: 'Not a participant' });
    }

    const clearedAt = new Date();
    convo.clearedBy = convo.clearedBy.filter((c) => String(c.user) !== String(req.user._id));
    convo.clearedBy.push({ user: req.user._id, clearedAt });
    await convo.save();

    return res.json({ success: true, clearedAt });
  } catch (err) {
    console.error('[clearChat]', err);
    return res.status(500).json({ success: false, message: 'Could not clear chat' });
  }
};

exports.isBlockedPair = isBlockedPair;
exports.canMessage = canMessage;
exports.ensureDirectConversation = ensureDirectConversation;
