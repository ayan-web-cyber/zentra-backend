const mongoose = require('mongoose');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const SavedPost = require('../models/SavedPost');
const HiddenPost = require('../models/HiddenPost');
const Media = require('../models/Media');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const Community = require('../models/Community');
const Song = require('../models/Song');
const notify = require('../utils/notify');
const { assertParticipant, serializeMessage } = require('./messageController');

// Pulls @username tokens out of a caption and resolves them to real, existing users.
async function extractMentions(caption) {
  if (!caption) return [];
  const handles = [...caption.matchAll(/@([a-z0-9_.]{3,30})/gi)].map((m) => m[1].toLowerCase());
  if (!handles.length) return [];
  const users = await User.find({ username: { $in: [...new Set(handles)] } }).select('_id');
  return users.map((u) => u._id);
}

// Checks whether `viewer` is allowed to see a post authored by `author`, given the post's visibility.
function canView(post, viewerId, author) {
  if (String(author._id) === String(viewerId)) return true;
  switch (post.visibility) {
    case 'everyone':
      return true;
    case 'followers':
      return author.followers.some((f) => String(f) === String(viewerId));
    case 'friends':
      return author.friends.some((f) => String(f) === String(viewerId));
    case 'onlyMe':
      return false;
    default:
      return true;
  }
}

async function serializePost(post, viewerId, savedPostIds) {
  const obj = post.toObject();
  const authorFollowers = obj.author?.followers || [];
  return {
    ...obj,
    author: obj.author
      ? { _id: obj.author._id, name: obj.author.name, username: obj.author.username, avatarUrl: obj.author.avatarUrl }
      : obj.author,
    media: obj.media?.map((m) => ({ id: m._id, url: `/api/media/${m.gridfsId}`, mimeType: m.mimeType })) || [],
    song: obj.song
      ? {
          id: obj.song._id,
          title: obj.song.title,
          artist: obj.song.artist,
          audioUrl: obj.song.audioUrl,
          coverColor: obj.song.coverColor,
          duration: obj.song.duration,
        }
      : null,
    taggedUsers: obj.taggedUsers?.map((u) => ({ _id: u._id, name: u.name, username: u.username })) || [],
    likeCount: obj.likes.length,
    isLiked: viewerId ? obj.likes.some((id) => String(id) === String(viewerId)) : false,
    isSaved: savedPostIds ? savedPostIds.has(String(obj._id)) : false,
    isOwner: viewerId ? String(obj.author._id || obj.author) === String(viewerId) : false,
    isFollowingAuthor: viewerId ? authorFollowers.some((f) => String(f) === String(viewerId)) : false,
    likes: undefined,
    mentions: undefined,
  };
}

// POST /api/posts
exports.createPost = async (req, res) => {
  try {
    const {
      type,
      caption,
      mediaIds,
      mood,
      visibility,
      poll,
      coAuthorUsernames,
      taggedUsernames,
      isReel,
      communityId,
      songId,
    } = req.body;

    if (!['text', 'photo', 'video', 'multiPhoto', 'poll', 'voice', 'music'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid post type' });
    }

    let song = null;
    if (type === 'music') {
      if (!songId) return res.status(400).json({ success: false, message: 'Choose a song for this post' });
      song = await Song.findById(songId);
      if (!song) return res.status(400).json({ success: false, message: 'That song is no longer available' });
    }

    let community = null;
    if (communityId) {
      community = await Community.findById(communityId);
      if (!community) return res.status(404).json({ success: false, message: 'Community not found' });
      const isMember = community.members.some((m) => String(m) === String(req.user._id));
      if (!isMember) {
        return res.status(403).json({ success: false, message: 'Join the community to post there' });
      }
    }

    let mediaDocIds = [];
    if (mediaIds?.length) {
      const mediaDocs = await Media.find({ _id: { $in: mediaIds }, owner: req.user._id });
      if (mediaDocs.length !== mediaIds.length) {
        return res.status(400).json({ success: false, message: 'One or more media items are invalid' });
      }
      mediaDocIds = mediaDocs.map((m) => m._id);
    }

    let coAuthors = [];
    if (coAuthorUsernames?.length) {
      const users = await User.find({ username: { $in: coAuthorUsernames.map((u) => u.toLowerCase()) } });
      coAuthors = users.map((u) => u._id);
    }

    let taggedUsers = [];
    if (taggedUsernames?.length) {
      const users = await User.find({ username: { $in: taggedUsernames.map((u) => u.toLowerCase()) } });
      taggedUsers = users.map((u) => u._id);
    }

    const mentions = await extractMentions(caption);

    const post = await Post.create({
      author: req.user._id,
      coAuthors,
      taggedUsers,
      mentions,
      community: community?._id || null,
      type,
      isReel: type === 'video' && Boolean(isReel),
      caption: caption || '',
      media: mediaDocIds,
      song: song?._id || null,
      mood: mood || '',
      visibility: visibility || 'everyone',
      poll: type === 'poll' ? poll : undefined,
    });

    // Same "trending" signal the Story music picker already uses (see songController) —
    // sharing a song in a post counts toward it too, same catalog, one usage counter.
    if (song) await Song.findByIdAndUpdate(song._id, { $inc: { usageCount: 1 } });

    const populated = await Post.findById(post._id)
      .populate('author', 'name username avatarUrl followers')
      .populate('media')
      .populate('song')
      .populate('taggedUsers', 'name username avatarUrl')
      .populate('community', 'name slug icon');

    return res.status(201).json({ success: true, post: await serializePost(populated, req.user._id) });
  } catch (err) {
    console.error('[createPost]', err);
    return res.status(500).json({ success: false, message: 'Could not create post' });
  }
};

// GET /api/posts/feed?cursor=&limit=
exports.getFeed = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 30);
    const cursor = req.query.cursor;

    // Muted and blocked people drop out of the feed entirely. Muting is silent and
    // one-directional (they're never told); blocking is mutual, so exclude anyone who has
    // blocked this viewer too, not just people the viewer blocked.
    const hiddenIds = [
      ...(req.user.mutedUsers || []),
      ...(req.user.blockedUsers || []),
    ].map(String);

    const blockedByOthers = await User.find({ blockedUsers: req.user._id }).select('_id');
    blockedByOthers.forEach((u) => hiddenIds.push(String(u._id)));

    const authorIds = [...req.user.following, req.user._id].filter(
      (id) => !hiddenIds.includes(String(id))
    );
    // Posts this viewer chose to hide (section 11) — a per-user relation, not a delete, so
    // the post is only excluded from *this* viewer's own feed query, never touched for
    // anyone else including its author.
    const hiddenPostRows = await HiddenPost.find({ user: req.user._id }).select('post');
    const query = { author: { $in: authorIds } };
    if (hiddenPostRows.length) query._id = { $nin: hiddenPostRows.map((r) => r.post) };
    if (cursor) query._id = { ...(query._id || {}), $lt: cursor };

    const posts = await Post.find(query)
      .sort({ _id: -1 })
      .limit(limit)
      .populate('author', 'name username avatarUrl followers')
      .populate('media')
      .populate('song')
      .populate('taggedUsers', 'name username avatarUrl')
      .populate('community', 'name slug icon');

    const savedRows = await SavedPost.find({ user: req.user._id, post: { $in: posts.map((p) => p._id) } });
    const savedIds = new Set(savedRows.map((r) => String(r.post)));

    const serialized = await Promise.all(posts.map((p) => serializePost(p, req.user._id, savedIds)));

    return res.json({
      success: true,
      posts: serialized,
      nextCursor: posts.length === limit ? posts[posts.length - 1]._id : null,
    });
  } catch (err) {
    console.error('[getFeed]', err);
    return res.status(500).json({ success: false, message: 'Could not load feed' });
  }
};

// GET /api/posts/:postId
exports.getPost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId)
      .populate('author', 'name username avatarUrl followers friends')
      .populate('media')
      .populate('song')
      .populate('taggedUsers', 'name username avatarUrl')
      .populate('community', 'name slug icon');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    if (!canView(post, req.user?._id, post.author)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this post' });
    }

    const savedRow = req.user ? await SavedPost.findOne({ user: req.user._id, post: post._id }) : null;
    return res.json({
      success: true,
      post: await serializePost(post, req.user?._id, savedRow ? new Set([String(post._id)]) : undefined),
    });
  } catch (err) {
    console.error('[getPost]', err);
    return res.status(500).json({ success: false, message: 'Could not load post' });
  }
};

// GET /api/posts/user/:username — all posts by one user, for their profile page.
// The requester only sees posts whose visibility allows them, unless viewing their own profile.
exports.getUserPosts = async (req, res) => {
  try {
    const author = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!author) return res.status(404).json({ success: false, message: 'User not found' });

    const viewerId = req.user?._id;
    const isSelf = viewerId && author._id.equals(viewerId);

    // Blocking cuts content access both ways, regardless of any other setting.
    if (viewerId && !isSelf) {
      const blocked =
        author.blockedUsers.some((b) => b.equals(viewerId)) ||
        (req.user.blockedUsers || []).some((b) => b.equals(author._id));
      if (blocked) {
        return res.json({ success: true, posts: [], isContentLocked: true, reason: 'blocked' });
      }
    }

    // Private accounts only show posts to followers/friends. This is the real boundary —
    // the isContentLocked flag on the profile response is just so the UI can explain why.
    if (!isSelf && author.isPrivate) {
      const allowed =
        viewerId &&
        (author.followers.some((f) => f.equals(viewerId)) || author.friends.some((f) => f.equals(viewerId)));
      if (!allowed) {
        return res.json({ success: true, posts: [], isContentLocked: true, reason: 'private' });
      }
    }

    const posts = await Post.find({ author: author._id })
      .sort({ _id: -1 })
      .populate('author', 'name username avatarUrl followers')
      .populate('media')
      .populate('song')
      .populate('taggedUsers', 'name username avatarUrl')
      .populate('community', 'name slug icon');

    const visible = posts.filter((p) => canView(p, req.user?._id, author));

    const savedRows = req.user
      ? await SavedPost.find({ user: req.user._id, post: { $in: visible.map((p) => p._id) } })
      : [];
    const savedIds = new Set(savedRows.map((r) => String(r.post)));

    const serialized = await Promise.all(visible.map((p) => serializePost(p, req.user?._id, savedIds)));
    return res.json({ success: true, posts: serialized, isContentLocked: false });
  } catch (err) {
    console.error('[getUserPosts]', err);
    return res.status(500).json({ success: false, message: 'Could not load posts' });
  }
};

// PUT /api/posts/:postId
exports.updatePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    if (String(post.author) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (req.body.caption !== undefined) post.caption = req.body.caption;
    if (req.body.visibility !== undefined) post.visibility = req.body.visibility;
    post.isEdited = true;
    await post.save();

    return res.json({ success: true, post: await serializePost(post, req.user._id) });
  } catch (err) {
    console.error('[updatePost]', err);
    return res.status(500).json({ success: false, message: 'Could not update post' });
  }
};

// DELETE /api/posts/:postId
exports.deletePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    const isAuthor = String(post.author) === String(req.user._id);
    let isCommunityAdmin = false;
    if (!isAuthor && post.community) {
      // A community admin/moderator can delete any post inside their own community,
      // in addition to deleting/editing their own posts anywhere.
      const community = await Community.findById(post.community);
      isCommunityAdmin = !!community && community.moderators.some((m) => String(m) === String(req.user._id));
    }
    if (!isAuthor && !isCommunityAdmin) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    await Promise.all([
      post.deleteOne(),
      Comment.deleteMany({ post: post._id }),
      SavedPost.deleteMany({ post: post._id }),
    ]);

    return res.json({ success: true, message: 'Post deleted' });
  } catch (err) {
    console.error('[deletePost]', err);
    return res.status(500).json({ success: false, message: 'Could not delete post' });
  }
};

// POST /api/posts/:postId/like
exports.likePost = async (req, res) => {
  try {
    const post = await Post.findByIdAndUpdate(
      req.params.postId,
      { $addToSet: { likes: req.user._id } },
      { new: true }
    );
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    notify(req.app.get('io'), {
      recipient: post.author,
      actor: req.user._id,
      type: 'like',
      post: post._id,
    });
    return res.json({ success: true, likeCount: post.likes.length });
  } catch (err) {
    console.error('[likePost]', err);
    return res.status(500).json({ success: false, message: 'Could not like post' });
  }
};

// DELETE /api/posts/:postId/like
exports.unlikePost = async (req, res) => {
  try {
    const post = await Post.findByIdAndUpdate(
      req.params.postId,
      { $pull: { likes: req.user._id } },
      { new: true }
    );
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    return res.json({ success: true, likeCount: post.likes.length });
  } catch (err) {
    console.error('[unlikePost]', err);
    return res.status(500).json({ success: false, message: 'Could not unlike post' });
  }
};

// POST /api/posts/:postId/share — records the share as a count (a "quote/repost" model can extend this later)
exports.sharePost = async (req, res) => {
  try {
    const post = await Post.findByIdAndUpdate(
      req.params.postId,
      { $inc: { shareCount: 1 } },
      { new: true }
    );
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    return res.json({ success: true, shareCount: post.shareCount });
  } catch (err) {
    console.error('[sharePost]', err);
    return res.status(500).json({ success: false, message: 'Could not share post' });
  }
};

// POST /api/posts/:postId/share-to  { conversationIds: [ids] }
// The "send to a friend" half of the share sheet — copy-link/native-share/download all
// go through the plain sharePost counter above; this is the one that actually delivers
// the post somewhere, as a chat message of type 'post' (see Message model). Mirrors
// messageController.forwardMessage's shape closely on purpose: same per-conversation
// participant check, same "skip conversations I'm not in" behavior, same style of
// building+emitting the message — sharing a post into chat isn't a fundamentally
// different operation from forwarding a message into chat.
exports.sharePostToConversations = async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId).populate('author', 'name username avatarUrl followers friends');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    if (!canView(post, req.user._id, post.author)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this post' });
    }

    const conversationIds = Array.isArray(req.body.conversationIds) ? req.body.conversationIds : [];
    if (!conversationIds.length) {
      return res.status(400).json({ success: false, message: 'Choose at least one conversation' });
    }

    const io = req.app.get('io');
    const created = [];

    for (const conversationId of conversationIds) {
      const convo = await assertParticipant(conversationId, req.user._id);
      if (!convo) continue; // silently skip conversations the sender isn't part of

      const message = await Message.create({
        conversation: conversationId,
        sender: req.user._id,
        type: 'post',
        sharedPost: post._id,
        deliveredTo: [req.user._id],
        readBy: [req.user._id],
      });

      const populated = await Message.findById(message._id)
        .populate('sender', 'name username avatarUrl')
        .populate({
          path: 'sharedPost',
          populate: [
            { path: 'author', select: 'name username avatarUrl' },
            { path: 'media' },
            { path: 'song', select: 'title artist' },
          ],
        });

      await Conversation.findByIdAndUpdate(conversationId, {
        lastMessage: { text: 'Shared a post', sender: req.user._id, sentAt: new Date() },
        updatedAt: new Date(),
        $pull: { leftBy: req.user._id },
      });

      const serialized = serializeMessage(populated);
      io?.to(`conversation:${conversationId}`).emit('message:new', serialized);
      created.push(serialized);
    }

    if (!created.length) {
      return res.status(403).json({ success: false, message: 'Not authorized for the selected conversations' });
    }

    // Counts the same as any other share (copy link, native share) — one counter for
    // every way a post left the feed, not a separate number just for in-app sends.
    await Post.findByIdAndUpdate(post._id, { $inc: { shareCount: 1 } });

    return res.status(201).json({ success: true, messages: created });
  } catch (err) {
    console.error('[sharePostToConversations]', err);
    return res.status(500).json({ success: false, message: 'Could not share this post' });
  }
};

// POST /api/posts/:postId/save
exports.savePost = async (req, res) => {
  try {
    await SavedPost.updateOne(
      { user: req.user._id, post: req.params.postId },
      { $setOnInsert: { user: req.user._id, post: req.params.postId } },
      { upsert: true }
    );
    return res.json({ success: true, message: 'Post saved' });
  } catch (err) {
    console.error('[savePost]', err);
    return res.status(500).json({ success: false, message: 'Could not save post' });
  }
};

// DELETE /api/posts/:postId/save
exports.unsavePost = async (req, res) => {
  try {
    await SavedPost.deleteOne({ user: req.user._id, post: req.params.postId });
    return res.json({ success: true, message: 'Post unsaved' });
  } catch (err) {
    console.error('[unsavePost]', err);
    return res.status(500).json({ success: false, message: 'Could not unsave post' });
  }
};

// GET /api/posts/saved
exports.getSavedPosts = async (req, res) => {
  try {
    const rows = await SavedPost.find({ user: req.user._id }).sort('-createdAt');
    const posts = await Post.find({ _id: { $in: rows.map((r) => r.post) } })
      .populate('author', 'name username avatarUrl followers')
      .populate('media')
      .populate('song')
      .populate('taggedUsers', 'name username avatarUrl')
      .populate('community', 'name slug icon');
    const savedIds = new Set(rows.map((r) => String(r.post)));
    // Post.find({ $in }) does not preserve `rows`' order, so re-sort the fetched posts
    // back into most-recently-saved-first order (and drop rows whose post was deleted).
    const postsById = new Map(posts.map((p) => [String(p._id), p]));
    const ordered = rows.map((r) => postsById.get(String(r.post))).filter(Boolean);
    const serialized = await Promise.all(ordered.map((p) => serializePost(p, req.user._id, savedIds)));
    return res.json({ success: true, posts: serialized });
  } catch (err) {
    console.error('[getSavedPosts]', err);
    return res.status(500).json({ success: false, message: 'Could not load saved posts' });
  }
};

// POST /api/posts/:postId/hide
// Hides a post from the current user's own feed only. Mirrors save/unsave exactly: a
// per-user relation row, upserted so a duplicate hide is a harmless no-op rather than a
// duplicate-key error, and the original Post document is never modified.
exports.hidePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId).select('_id');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    await HiddenPost.updateOne(
      { user: req.user._id, post: req.params.postId },
      { $setOnInsert: { user: req.user._id, post: req.params.postId } },
      { upsert: true }
    );
    return res.json({ success: true, message: 'Post hidden' });
  } catch (err) {
    console.error('[hidePost]', err);
    return res.status(500).json({ success: false, message: 'Could not hide post' });
  }
};

// DELETE /api/posts/:postId/hide
// Powers the "Undo" toast immediately after hiding — reverses the relation, nothing else.
exports.unhidePost = async (req, res) => {
  try {
    await HiddenPost.deleteOne({ user: req.user._id, post: req.params.postId });
    return res.json({ success: true, message: 'Post unhidden' });
  } catch (err) {
    console.error('[unhidePost]', err);
    return res.status(500).json({ success: false, message: 'Could not unhide post' });
  }
};

// POST /api/posts/:postId/vote  { optionIndex }
exports.votePoll = async (req, res) => {
  try {
    const { optionIndex } = req.body;
    const post = await Post.findById(req.params.postId);
    if (!post || post.type !== 'poll') {
      return res.status(404).json({ success: false, message: 'Poll not found' });
    }
    if (!post.poll.options[optionIndex]) {
      return res.status(400).json({ success: false, message: 'Invalid option' });
    }

    const alreadyVoted = post.poll.options.some((opt) =>
      opt.votes.some((v) => String(v) === String(req.user._id))
    );
    if (alreadyVoted) {
      return res.status(409).json({ success: false, message: 'You already voted on this poll' });
    }

    post.poll.options[optionIndex].votes.push(req.user._id);
    await post.save();

    return res.json({
      success: true,
      results: post.poll.options.map((o) => ({ text: o.text, votes: o.votes.length })),
    });
  } catch (err) {
    console.error('[votePoll]', err);
    return res.status(500).json({ success: false, message: 'Could not register vote' });
  }
};

// GET /api/posts/reels/feed?cursor=&limit= — vertical short-video feed, public "everyone" reels only for now
exports.getReelsFeed = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 6, 20);
    const cursor = req.query.cursor;

    const query = { isReel: true, visibility: 'everyone' };
    if (cursor) query._id = { $lt: cursor };

    const reels = await Post.find(query)
      .sort({ _id: -1 })
      .limit(limit)
      .populate('author', 'name username avatarUrl followers')
      .populate('media');

    const savedRows = req.user
      ? await SavedPost.find({ user: req.user._id, post: { $in: reels.map((r) => r._id) } })
      : [];
    const savedIds = new Set(savedRows.map((r) => String(r.post)));

    const serialized = await Promise.all(reels.map((r) => serializePost(r, req.user?._id, savedIds)));
    return res.json({
      success: true,
      reels: serialized,
      nextCursor: reels.length === limit ? reels[reels.length - 1]._id : null,
    });
  } catch (err) {
    console.error('[getReelsFeed]', err);
    return res.status(500).json({ success: false, message: 'Could not load reels' });
  }
};

// Exposed for other controllers (e.g. community post feeds) that need the same
// author/media/likes shaping without duplicating it.
exports.serializePost = serializePost;
