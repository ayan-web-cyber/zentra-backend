const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

// Fixed reaction set (section 3.1) — keeps the picker predictable and the reactions array
// from becoming a place to stash arbitrary emoji/text.
const ALLOWED_REACTIONS = new Set(['❤️', '👍', '😂', '😮', '😢', '😡', '🎉']);

// Shared by every spot that returns a message, so a shared-post card renders correctly
// whether it just arrived (sharePostToConversations), was loaded from history
// (getMessages), was re-fetched after an edit, or was forwarded onward.
const SHARED_POST_POPULATE = {
  path: 'sharedPost',
  populate: [
    { path: 'author', select: 'name username avatarUrl' },
    { path: 'media' },
    { path: 'song', select: 'title artist' },
  ],
};

function serializeMessage(msg) {
  const obj = msg.toObject ? msg.toObject() : msg;
  return {
    ...obj,
    media: obj.media?.gridfsId
      ? {
          url: `/api/media/${obj.media.gridfsId}`,
          mimeType: obj.media.mimeType,
          filename: obj.media.filename,
          size: obj.media.size,
        }
      : null,
    forwardedFrom:
      obj.forwardedFrom && typeof obj.forwardedFrom === 'object' && obj.forwardedFrom.type
        ? serializeMessage(obj.forwardedFrom)
        : obj.forwardedFrom,
    // Only ever a preview card, never the full post — no likes/visibility/coAuthors/etc,
    // just enough to render the card and link to /post/:id for the rest.
    sharedPost:
      obj.sharedPost && typeof obj.sharedPost === 'object' && obj.sharedPost.type
        ? {
            _id: obj.sharedPost._id,
            type: obj.sharedPost.type,
            caption: obj.sharedPost.caption,
            author: obj.sharedPost.author
              ? {
                  _id: obj.sharedPost.author._id,
                  name: obj.sharedPost.author.name,
                  username: obj.sharedPost.author.username,
                  avatarUrl: obj.sharedPost.author.avatarUrl,
                }
              : null,
            thumbnailUrl: obj.sharedPost.media?.[0]?.gridfsId
              ? `/api/media/${obj.sharedPost.media[0].gridfsId}`
              : null,
            song: obj.sharedPost.song ? { title: obj.sharedPost.song.title, artist: obj.sharedPost.song.artist } : null,
          }
        : obj.sharedPost,
    reactionCount: obj.reactions.length,
  };
}

async function assertParticipant(conversationId, userId) {
  const convo = await Conversation.findById(conversationId);
  if (!convo) return null;
  if (!convo.participants.some((p) => String(p) === String(userId))) return false;
  return convo;
}

// "Clear chat" only hides history for the user who cleared it — it never deletes anything,
// so it has to be applied as a per-request filter rather than a document change.
function clearedAtFor(convo, userId) {
  const entry = (convo.clearedBy || []).find((c) => String(c.user) === String(userId));
  return entry?.clearedAt || null;
}

// GET /api/conversations/:id/messages?cursor=&limit=
exports.getMessages = async (req, res) => {
  try {
    const convo = await assertParticipant(req.params.id, req.user._id);
    if (convo === null) return res.status(404).json({ success: false, message: 'Conversation not found' });
    if (convo === false) return res.status(403).json({ success: false, message: 'Not a participant' });

    const limit = Math.min(Number(req.query.limit) || 30, 60);
    const query = { conversation: req.params.id };
    if (req.query.cursor) query._id = { $lt: req.query.cursor };

    const clearedAt = clearedAtFor(convo, req.user._id);
    if (clearedAt) query.createdAt = { ...(query.createdAt || {}), $gt: clearedAt };

    const messages = await Message.find(query)
      .sort({ _id: -1 })
      .limit(limit)
      .populate('sender', 'name username avatarUrl')
      .populate('media')
      .populate({ path: 'replyTo', populate: { path: 'sender', select: 'name username' } })
      .populate({ path: 'forwardedFrom', populate: { path: 'sender', select: 'name username' } })
      .populate(SHARED_POST_POPULATE);

    return res.json({
      success: true,
      messages: messages.reverse().map(serializeMessage),
      nextCursor: messages.length === limit ? messages[0]._id : null,
    });
  } catch (err) {
    console.error('[getMessages]', err);
    return res.status(500).json({ success: false, message: 'Could not load messages' });
  }
};

// PUT /api/messages/:messageId  { text }
exports.editMessage = async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ success: false, message: 'Message not found' });
    if (String(message.sender) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (message.isDeleted) {
      return res.status(400).json({ success: false, message: 'Cannot edit a deleted message' });
    }
    if (message.type !== 'text') {
      return res.status(400).json({ success: false, message: 'Only text messages can be edited' });
    }
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ success: false, message: 'Message text cannot be empty' });

    message.text = text;
    message.isEdited = true;
    await message.save();

    // Re-populate before serializing — the client merges this payload straight into its
    // existing message object ({...old, ...updated}), so any field sent back unpopulated
    // (e.g. `sender` as a bare ObjectId instead of {_id, name, ...}) overwrites and breaks
    // the populated version already on screen. `sender` in particular fed the isOwn check,
    // so a bare id there was flipping the edited bubble onto the wrong side of the chat.
    const populated = await Message.findById(message._id)
      .populate('sender', 'name username avatarUrl')
      .populate('media')
      .populate({ path: 'replyTo', populate: { path: 'sender', select: 'name username' } })
      .populate({ path: 'forwardedFrom', populate: { path: 'sender', select: 'name username' } })
      .populate(SHARED_POST_POPULATE);

    const serialized = serializeMessage(populated);
    req.app.get('io')?.to(`conversation:${message.conversation}`).emit('message:edited', serialized);

    return res.json({ success: true, message: serialized });
  } catch (err) {
    console.error('[editMessage]', err);
    return res.status(500).json({ success: false, message: 'Could not edit message' });
  }
};

// DELETE /api/messages/:messageId — "delete for everyone", sender-only
exports.deleteMessage = async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ success: false, message: 'Message not found' });
    if (String(message.sender) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    message.isDeleted = true;
    message.text = '';
    message.media = undefined;
    await message.save();

    req.app.get('io')?.to(`conversation:${message.conversation}`).emit('message:deleted', {
      messageId: String(message._id),
      conversationId: String(message.conversation),
    });

    return res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    console.error('[deleteMessage]', err);
    return res.status(500).json({ success: false, message: 'Could not delete message' });
  }
};

// POST /api/messages/:messageId/react  { emoji }
// Toggle semantics: reacting with the same emoji you already reacted with removes it
// ("remove own reaction"); reacting with a different emoji swaps it (one reaction per user,
// same as before) — this keeps the picker a single tap-to-toggle control per emoji.
exports.reactToMessage = async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ success: false, message: 'Message not found' });
    if (message.isDeleted) {
      return res.status(400).json({ success: false, message: 'Cannot react to a deleted message' });
    }

    const emoji = req.body.emoji;
    if (emoji && !ALLOWED_REACTIONS.has(emoji)) {
      return res.status(400).json({ success: false, message: 'Unsupported reaction' });
    }

    const existing = message.reactions.find((r) => String(r.user) === String(req.user._id));
    const alreadyHadThisEmoji = existing && existing.emoji === emoji;

    message.reactions = message.reactions.filter((r) => String(r.user) !== String(req.user._id));
    if (emoji && !alreadyHadThisEmoji) {
      message.reactions.push({ user: req.user._id, emoji });
    }
    await message.save();

    const payload = {
      messageId: String(message._id),
      conversationId: String(message.conversation),
      reactions: message.reactions,
    };
    req.app.get('io')?.to(`conversation:${message.conversation}`).emit('message:reaction:update', payload);

    return res.json({ success: true, reactions: message.reactions });
  } catch (err) {
    console.error('[reactToMessage]', err);
    return res.status(500).json({ success: false, message: 'Could not react to message' });
  }
};

// POST /api/messages/:messageId/forward  { conversationIds: [ids] }
// Forwards the message's content (text/media reference) into one or more conversations
// the sender is a participant of. Does not duplicate the underlying media file — the new
// message just points at the same Media document — and chains forwardedFrom back to the
// ORIGINAL message rather than to an intermediate forward, so re-forwarding a forward never
// builds a chain and a viewer always sees "Forwarded" pointing at the true source.
exports.forwardMessage = async (req, res) => {
  try {
    const source = await Message.findById(req.params.messageId).populate('forwardedFrom');
    if (!source || source.isDeleted) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }

    const conversationIds = Array.isArray(req.body.conversationIds) ? req.body.conversationIds : [];
    if (!conversationIds.length) {
      return res.status(400).json({ success: false, message: 'Choose at least one conversation' });
    }

    // Must be a participant of the SOURCE conversation to forward out of it.
    const sourceConvo = await assertParticipant(source.conversation, req.user._id);
    if (!sourceConvo) return res.status(403).json({ success: false, message: 'Not authorized' });

    const originalId = source.forwardedFrom?._id || source._id;
    const io = req.app.get('io');
    const created = [];

    for (const conversationId of conversationIds) {
      const targetConvo = await assertParticipant(conversationId, req.user._id);
      if (!targetConvo) continue; // silently skip conversations the user isn't part of

      const message = await Message.create({
        conversation: conversationId,
        sender: req.user._id,
        type: source.type,
        text: source.text,
        media: source.media,
        sharedPost: source.sharedPost,
        forwardedFrom: originalId,
        deliveredTo: [req.user._id],
        readBy: [req.user._id],
      });

      const populated = await Message.findById(message._id)
        .populate('sender', 'name username avatarUrl')
        .populate('media')
        .populate({ path: 'forwardedFrom', populate: { path: 'sender', select: 'name username' } })
        .populate(SHARED_POST_POPULATE);

      await Conversation.findByIdAndUpdate(conversationId, {
        lastMessage: {
          text: source.type === 'text' ? source.text : `Forwarded a ${source.type}`,
          sender: req.user._id,
          sentAt: new Date(),
        },
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

    return res.status(201).json({ success: true, messages: created });
  } catch (err) {
    console.error('[forwardMessage]', err);
    return res.status(500).json({ success: false, message: 'Could not forward message' });
  }
};

// POST /api/conversations/:id/read — marks every message in the conversation as read by me
exports.markConversationRead = async (req, res) => {
  try {
    await Message.updateMany(
      { conversation: req.params.id, readBy: { $ne: req.user._id } },
      { $addToSet: { readBy: req.user._id, deliveredTo: req.user._id } }
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[markConversationRead]', err);
    return res.status(500).json({ success: false, message: 'Could not mark as read' });
  }
};

// GET /api/conversations/:id/messages/search?q=
// Searches this conversation's full text-message history (not just what the client
// has loaded), respecting the same "cleared chat" cutoff as getMessages.
exports.searchMessages = async (req, res) => {
  try {
    const convo = await assertParticipant(req.params.id, req.user._id);
    if (convo === null) return res.status(404).json({ success: false, message: 'Conversation not found' });
    if (convo === false) return res.status(403).json({ success: false, message: 'Not a participant' });

    const q = (req.query.q || '').trim();
    if (!q) return res.json({ success: true, messages: [] });

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query = {
      conversation: req.params.id,
      type: 'text',
      isDeleted: false,
      text: new RegExp(escaped, 'i'),
    };
    const clearedAt = clearedAtFor(convo, req.user._id);
    if (clearedAt) query.createdAt = { $gt: clearedAt };

    const messages = await Message.find(query)
      .sort({ _id: -1 })
      .limit(50)
      .populate('sender', 'name username avatarUrl');

    return res.json({ success: true, messages: messages.map(serializeMessage) });
  } catch (err) {
    console.error('[searchMessages]', err);
    return res.status(500).json({ success: false, message: 'Search failed' });
  }
};

exports.serializeMessage = serializeMessage;
exports.assertParticipant = assertParticipant;
