const Community = require('../models/Community');
const Post = require('../models/Post');
const SavedPost = require('../models/SavedPost');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');

const MEMBER_LEAVE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

function slugify(name) {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'community'
  );
}

async function uniqueSlug(name) {
  const base = slugify(name);
  let slug = base;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await Community.findOne({ slug })) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function serializeCommunity(community, viewerId) {
  const obj = community.toObject();
  const isMember = viewerId ? obj.members.some((m) => String(m) === String(viewerId)) : false;
  const isModerator = viewerId ? obj.moderators.some((m) => String(m) === String(viewerId)) : false;
  const isCreator = viewerId ? String(obj.creator?._id || obj.creator) === String(viewerId) : false;

  // Viewer's own join time (if a member), used by the client to show/enforce the
  // "can leave 24h after joining" rule without a second round trip.
  const joinedEntry = viewerId
    ? (obj.memberJoinedAt || []).find((m) => String(m.user) === String(viewerId))
    : null;

  return {
    ...obj,
    cover: obj.cover ? { id: obj.cover._id, url: `/api/media/${obj.cover.gridfsId}` } : null,
    avatar: obj.avatar ? { id: obj.avatar._id, url: `/api/media/${obj.avatar.gridfsId}` } : null,
    memberCount: obj.members.length,
    members: undefined, // full member list fetched separately via /members to keep this payload light
    memberJoinedAt: undefined,
    pendingInvites: undefined, // never expose the raw invite list to a general viewer
    isMember,
    isModerator: isModerator || isCreator,
    isCreator,
    viewerJoinedAt: joinedEntry ? joinedEntry.joinedAt : null,
    leaveCooldownMs: MEMBER_LEAVE_COOLDOWN_MS,
  };
}

const POPULATE = [
  { path: 'cover' },
  { path: 'avatar' },
  { path: 'creator', select: 'name username avatarUrl' },
];

// GET /api/communities?search=&category=&mine=
exports.listCommunities = async (req, res) => {
  try {
    const { search, category, mine } = req.query;
    const query = {};
    if (mine === 'true') query.members = req.user._id;
    if (category && category !== 'All') query.category = category;
    if (search) query.$text = { $search: search };

    const communities = await Community.find(query)
      .sort(search ? { score: { $meta: 'textScore' } } : { createdAt: -1 })
      .limit(50)
      .populate(POPULATE);

    return res.json({
      success: true,
      communities: communities.map((c) => serializeCommunity(c, req.user?._id)),
    });
  } catch (err) {
    console.error('[listCommunities]', err);
    return res.status(500).json({ success: false, message: 'Could not load communities' });
  }
};

// POST /api/communities
exports.createCommunity = async (req, res) => {
  try {
    const { name, description, icon, category, privacy, coverId, avatarId } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'Community name is required' });
    }

    const slug = await uniqueSlug(name);
    const community = await Community.create({
      name: name.trim(),
      slug,
      description: description || '',
      icon: icon || '💬',
      category: category || 'Other',
      privacy: privacy === 'private' ? 'private' : 'public',
      cover: coverId || null,
      avatar: avatarId || null,
      creator: req.user._id,
      moderators: [req.user._id],
      members: [req.user._id],
      memberJoinedAt: [{ user: req.user._id, joinedAt: new Date() }],
    });

    const populated = await Community.findById(community._id).populate(POPULATE);
    return res.status(201).json({ success: true, community: serializeCommunity(populated, req.user._id) });
  } catch (err) {
    console.error('[createCommunity]', err);
    return res.status(500).json({ success: false, message: 'Could not create community' });
  }
};

// GET /api/communities/:idOrSlug
exports.getCommunity = async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const query = idOrSlug.match(/^[0-9a-fA-F]{24}$/) ? { _id: idOrSlug } : { slug: idOrSlug };
    const community = await Community.findOne(query).populate(POPULATE);
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });

    return res.json({ success: true, community: serializeCommunity(community, req.user?._id) });
  } catch (err) {
    console.error('[getCommunity]', err);
    return res.status(500).json({ success: false, message: 'Could not load community' });
  }
};

// PUT /api/communities/:communityId — creator/moderator only
exports.updateCommunity = async (req, res) => {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });
    const isModerator = community.moderators.some((m) => String(m) === String(req.user._id));
    if (!isModerator) return res.status(403).json({ success: false, message: 'Only moderators can edit this community' });

    const { name, description, icon, category, privacy, coverId, avatarId } = req.body;
    if (name?.trim()) community.name = name.trim();
    if (description !== undefined) community.description = description;
    if (icon) community.icon = icon;
    if (category) community.category = category;
    if (privacy) community.privacy = privacy === 'private' ? 'private' : 'public';
    if (coverId !== undefined) community.cover = coverId || null;
    if (avatarId !== undefined) community.avatar = avatarId || null;
    await community.save();

    const populated = await Community.findById(community._id).populate(POPULATE);
    return res.json({ success: true, community: serializeCommunity(populated, req.user._id) });
  } catch (err) {
    console.error('[updateCommunity]', err);
    return res.status(500).json({ success: false, message: 'Could not update community' });
  }
};

// DELETE /api/communities/:communityId — creator only
exports.deleteCommunity = async (req, res) => {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });
    if (String(community.creator) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Only the creator can delete this community' });
    }

    // The community's group chat belongs to the community, not to any one member — when the
    // community goes away, its chat must disappear from every member's chat list too, not just
    // whoever happened to click delete.
    if (community.conversation) {
      const conversationId = community.conversation;
      const memberIds = community.members.map((m) => String(m));
      await Message.deleteMany({ conversation: conversationId });
      await Conversation.findByIdAndDelete(conversationId);

      const io = req.app.get('io');
      memberIds.forEach((id) => io?.to(`user:${id}`).emit('conversation:removed', { conversationId: String(conversationId) }));
    }

    await community.deleteOne();
    await Post.updateMany({ community: community._id }, { $set: { community: null } });
    return res.json({ success: true, message: 'Community deleted' });
  } catch (err) {
    console.error('[deleteCommunity]', err);
    return res.status(500).json({ success: false, message: 'Could not delete community' });
  }
};

// POST /api/communities/:communityId/join
exports.joinCommunity = async (req, res) => {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });

    const already = community.members.some((m) => String(m) === String(req.user._id));
    if (already) return res.status(409).json({ success: false, message: 'Already a member' });

    community.members.push(req.user._id);
    community.memberJoinedAt.push({ user: req.user._id, joinedAt: new Date() });
    await community.save();

    // Keep an existing community chat in sync so new joiners land in the conversation too.
    if (community.conversation) {
      await Conversation.findByIdAndUpdate(community.conversation, {
        $addToSet: { participants: req.user._id },
        $pull: { leftBy: req.user._id },
      });
    }

    return res.json({ success: true, memberCount: community.members.length });
  } catch (err) {
    console.error('[joinCommunity]', err);
    return res.status(500).json({ success: false, message: 'Could not join community' });
  }
};

// POST /api/communities/:communityId/leave
exports.leaveCommunity = async (req, res) => {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });
    if (String(community.creator) === String(req.user._id)) {
      return res.status(400).json({
        success: false,
        message: 'The creator can\u2019t leave. Delete the community or transfer ownership instead.',
      });
    }

    const joinedEntry = community.memberJoinedAt.find((m) => String(m.user) === String(req.user._id));
    if (joinedEntry) {
      const elapsed = Date.now() - new Date(joinedEntry.joinedAt).getTime();
      if (elapsed < MEMBER_LEAVE_COOLDOWN_MS) {
        const hoursLeft = Math.ceil((MEMBER_LEAVE_COOLDOWN_MS - elapsed) / (60 * 60 * 1000));
        return res.status(403).json({
          success: false,
          message: `You can leave this community 24 hours after joining. Try again in about ${hoursLeft}h.`,
        });
      }
    }

    community.members = community.members.filter((m) => String(m) !== String(req.user._id));
    community.moderators = community.moderators.filter((m) => String(m) !== String(req.user._id));
    community.memberJoinedAt = community.memberJoinedAt.filter((m) => String(m.user) !== String(req.user._id));
    await community.save();

    if (community.conversation) {
      await Conversation.findByIdAndUpdate(community.conversation, {
        $pull: { participants: req.user._id },
        $addToSet: { leftBy: req.user._id },
      });
    }

    return res.json({ success: true, memberCount: community.members.length });
  } catch (err) {
    console.error('[leaveCommunity]', err);
    return res.status(500).json({ success: false, message: 'Could not leave community' });
  }
};

// DELETE /api/communities/:communityId/members/:userId — creator/moderator only, force-remove a member.
// Unlike /leave, this isn't subject to the 24h cooldown — that rule only governs a member
// choosing to leave on their own.
exports.removeMember = async (req, res) => {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });

    const isModerator = community.moderators.some((m) => String(m) === String(req.user._id));
    if (!isModerator) {
      return res.status(403).json({ success: false, message: 'Only admins can remove members' });
    }

    const { userId } = req.params;
    if (String(userId) === String(community.creator)) {
      return res.status(400).json({ success: false, message: 'The creator can\u2019t be removed' });
    }
    if (!community.members.some((m) => String(m) === String(userId))) {
      return res.status(404).json({ success: false, message: 'That user isn\u2019t a member' });
    }

    community.members = community.members.filter((m) => String(m) !== String(userId));
    community.moderators = community.moderators.filter((m) => String(m) !== String(userId));
    community.memberJoinedAt = community.memberJoinedAt.filter((m) => String(m.user) !== String(userId));
    await community.save();

    if (community.conversation) {
      await Conversation.findByIdAndUpdate(community.conversation, {
        $pull: { participants: userId },
        $addToSet: { leftBy: userId },
      });
    }

    return res.json({ success: true, memberCount: community.members.length });
  } catch (err) {
    console.error('[removeMember]', err);
    return res.status(500).json({ success: false, message: 'Could not remove member' });
  }
};

// POST /api/communities/:communityId/invite — admin/moderator only. Creates a pending
// invite; the invitee only becomes a member once they accept it (see respondToInvite).
exports.inviteMember = async (req, res) => {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });

    const isModerator = community.moderators.some((m) => String(m) === String(req.user._id));
    if (!isModerator) {
      return res.status(403).json({ success: false, message: 'Only admins can invite people to this community' });
    }

    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });

    const invitee = await User.findById(userId).select('name username avatarUrl');
    if (!invitee) return res.status(404).json({ success: false, message: 'User not found' });

    if (community.members.some((m) => String(m) === String(userId))) {
      return res.status(409).json({ success: false, message: `${invitee.name} is already a member` });
    }
    if (community.pendingInvites.some((i) => String(i.user) === String(userId))) {
      return res.status(409).json({ success: false, message: `${invitee.name} already has a pending invite` });
    }

    community.pendingInvites.push({ user: userId, invitedBy: req.user._id, invitedAt: new Date() });
    await community.save();

    return res.status(201).json({ success: true, invitee });
  } catch (err) {
    console.error('[inviteMember]', err);
    return res.status(500).json({ success: false, message: 'Could not invite user' });
  }
};

// DELETE /api/communities/:communityId/invites/:userId — admin only, revoke a pending invite.
exports.cancelInvite = async (req, res) => {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });
    const isModerator = community.moderators.some((m) => String(m) === String(req.user._id));
    if (!isModerator) {
      return res.status(403).json({ success: false, message: 'Only admins can manage invites' });
    }
    community.pendingInvites = community.pendingInvites.filter((i) => String(i.user) !== String(req.params.userId));
    await community.save();
    return res.json({ success: true });
  } catch (err) {
    console.error('[cancelInvite]', err);
    return res.status(500).json({ success: false, message: 'Could not cancel invite' });
  }
};

// GET /api/communities/invites/mine — communities the current user has a pending invite to.
exports.listMyInvites = async (req, res) => {
  try {
    const communities = await Community.find({ 'pendingInvites.user': req.user._id }).populate([
      ...POPULATE,
      { path: 'pendingInvites.invitedBy', select: 'name username avatarUrl' },
    ]);

    const invites = communities.map((c) => {
      const entry = c.pendingInvites.find((i) => String(i.user) === String(req.user._id));
      return {
        community: serializeCommunity(c, req.user._id),
        invitedBy: entry?.invitedBy
          ? { _id: entry.invitedBy._id, name: entry.invitedBy.name, username: entry.invitedBy.username }
          : null,
        invitedAt: entry?.invitedAt,
      };
    });

    return res.json({ success: true, invites });
  } catch (err) {
    console.error('[listMyInvites]', err);
    return res.status(500).json({ success: false, message: 'Could not load invites' });
  }
};

// POST /api/communities/:communityId/invites/respond — { accept: boolean }
exports.respondToInvite = async (req, res) => {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });

    const hasInvite = community.pendingInvites.some((i) => String(i.user) === String(req.user._id));
    if (!hasInvite) {
      return res.status(404).json({ success: false, message: 'No pending invite from this community' });
    }

    community.pendingInvites = community.pendingInvites.filter((i) => String(i.user) !== String(req.user._id));

    if (req.body.accept) {
      if (!community.members.some((m) => String(m) === String(req.user._id))) {
        community.members.push(req.user._id);
        community.memberJoinedAt.push({ user: req.user._id, joinedAt: new Date() });
      }
      await community.save();

      if (community.conversation) {
        await Conversation.findByIdAndUpdate(community.conversation, {
          $addToSet: { participants: req.user._id },
          $pull: { leftBy: req.user._id },
        });
      }

      const populated = await Community.findById(community._id).populate(POPULATE);
      return res.json({ success: true, joined: true, community: serializeCommunity(populated, req.user._id) });
    }

    await community.save();
    return res.json({ success: true, joined: false });
  } catch (err) {
    console.error('[respondToInvite]', err);
    return res.status(500).json({ success: false, message: 'Could not respond to invite' });
  }
};

// GET /api/communities/:communityId/members
exports.listMembers = async (req, res) => {
  try {
    const community = await Community.findById(req.params.communityId).populate(
      'members',
      'name username avatarUrl'
    );
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });

    const moderatorIds = new Set(community.moderators.map(String));
    const members = community.members.map((m) => ({
      _id: m._id,
      name: m.name,
      username: m.username,
      avatarUrl: m.avatarUrl,
      isModerator: moderatorIds.has(String(m._id)),
      isCreator: String(m._id) === String(community.creator),
    }));

    return res.json({ success: true, members });
  } catch (err) {
    console.error('[listMembers]', err);
    return res.status(500).json({ success: false, message: 'Could not load members' });
  }
};

// POST /api/communities/:communityId/moderators/:userId — creator only, promote a member
exports.addModerator = async (req, res) => {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });
    if (String(community.creator) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Only the creator can assign moderators' });
    }
    const { userId } = req.params;
    if (!community.members.some((m) => String(m) === userId)) {
      return res.status(400).json({ success: false, message: 'User must be a member first' });
    }
    if (!community.moderators.some((m) => String(m) === userId)) {
      community.moderators.push(userId);
      await community.save();
    }
    return res.json({ success: true, moderators: community.moderators });
  } catch (err) {
    console.error('[addModerator]', err);
    return res.status(500).json({ success: false, message: 'Could not update moderators' });
  }
};

// DELETE /api/communities/:communityId/moderators/:userId — creator only
exports.removeModerator = async (req, res) => {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });
    if (String(community.creator) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Only the creator can remove moderators' });
    }
    if (String(req.params.userId) === String(community.creator)) {
      return res.status(400).json({ success: false, message: 'The creator is always a moderator' });
    }
    community.moderators = community.moderators.filter((m) => String(m) !== req.params.userId);
    await community.save();
    return res.json({ success: true, moderators: community.moderators });
  } catch (err) {
    console.error('[removeModerator]', err);
    return res.status(500).json({ success: false, message: 'Could not update moderators' });
  }
};

// GET /api/communities/:communityId/posts?cursor=&limit=
exports.getCommunityPosts = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 30);
    const cursor = req.query.cursor;
    const query = { community: req.params.communityId };
    if (cursor) query._id = { $lt: cursor };

    const { serializePost } = require('./postController');
    const posts = await require('../models/Post')
      .find(query)
      .sort({ _id: -1 })
      .limit(limit)
      .populate('author', 'name username avatarUrl followers')
      .populate('media')
      .populate('taggedUsers', 'name username avatarUrl')
      .populate('community', 'name slug icon');

    const savedRows = req.user
      ? await SavedPost.find({ user: req.user._id, post: { $in: posts.map((p) => p._id) } })
      : [];
    const savedIds = new Set(savedRows.map((r) => String(r.post)));

    const serialized = await Promise.all(posts.map((p) => serializePost(p, req.user?._id, savedIds)));
    return res.json({
      success: true,
      posts: serialized,
      nextCursor: posts.length === limit ? posts[posts.length - 1]._id : null,
    });
  } catch (err) {
    console.error('[getCommunityPosts]', err);
    return res.status(500).json({ success: false, message: 'Could not load community posts' });
  }
};

// POST /api/communities/:communityId/chat — open (or lazily create) the community's group chat
exports.openCommunityChat = async (req, res) => {
  try {
    const community = await Community.findById(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, message: 'Community not found' });
    if (!community.members.some((m) => String(m) === String(req.user._id))) {
      return res.status(403).json({ success: false, message: 'Join the community to open its chat' });
    }

    if (!community.conversation) {
      const convo = await Conversation.create({
        participants: community.members,
        isGroup: true,
        groupName: community.name,
        admins: community.moderators,
        community: community._id,
      });
      community.conversation = convo._id;
      await community.save();
    } else {
      // The member may have previously deleted this chat from their list (leaveConversation,
      // for a community chat, only hides it — see that function's comment). Opening it again
      // is an explicit request to see it, so un-hide it and make sure they're still a participant.
      await Conversation.findByIdAndUpdate(community.conversation, {
        $addToSet: { participants: req.user._id },
        $pull: { leftBy: req.user._id },
      });
    }

    return res.json({ success: true, conversationId: community.conversation });
  } catch (err) {
    console.error('[openCommunityChat]', err);
    return res.status(500).json({ success: false, message: 'Could not open community chat' });
  }
};
