const mongoose = require('mongoose');
const aiService = require('../services/aiService');
const AiConversation = require('../models/AiConversation');

function handleAiError(res, err) {
  if (err.notConfigured) {
    return res.status(503).json({
      success: false,
      configured: false,
      message: 'AI features are not set up on this server yet. An admin can enable them by setting AI_PROVIDER and an API key in the server environment.',
    });
  }
  console.error('[ai]', err);
  return res.status(502).json({ success: false, message: 'The AI provider could not complete that request. Please try again.' });
}

// GET /api/ai/status — lets the frontend show/hide the AI Assist UI without a failed call
exports.getAiStatus = async (req, res) => {
  return res.json({ success: true, configured: aiService.isConfigured(), provider: aiService.PROVIDER });
};

// POST /api/ai/caption  { description, mood? } -> { captions: string[] }
exports.suggestCaptions = async (req, res) => {
  try {
    const { description, mood } = req.body;
    if (!description?.trim()) {
      return res.status(400).json({ success: false, message: 'Describe what the post is about first.' });
    }
    const captions = await aiService.generateCaptions({ description: description.trim(), mood });
    return res.json({ success: true, captions });
  } catch (err) {
    return handleAiError(res, err);
  }
};

// POST /api/ai/rewrite  { text, style? } -> { text: string }
exports.rewriteCaption = async (req, res) => {
  try {
    const { text, style } = req.body;
    if (!text?.trim()) {
      return res.status(400).json({ success: false, message: 'Nothing to rewrite yet.' });
    }
    const rewritten = await aiService.rewriteCaption({ text: text.trim(), style });
    return res.json({ success: true, text: rewritten });
  } catch (err) {
    return handleAiError(res, err);
  }
};

// POST /api/ai/translate  { text, targetLanguage } -> { text: string }
exports.translateCaption = async (req, res) => {
  try {
    const { text, targetLanguage } = req.body;
    if (!text?.trim() || !targetLanguage?.trim()) {
      return res.status(400).json({ success: false, message: 'Text and a target language are required.' });
    }
    const translated = await aiService.translateText({ text: text.trim(), targetLanguage: targetLanguage.trim() });
    return res.json({ success: true, text: translated });
  } catch (err) {
    return handleAiError(res, err);
  }
};

// --- AI Chat page — "ask anything", separate from the caption/rewrite/translate tools
// above. A user now has MANY named threads (see models/AiConversation.js) rather than one
// running conversation, so every handler below is scoped by both user and conversation id.
//
// Ownership rule for all of these: the lookup filter is always
// { _id: id, user: req.user._id }. Never "find by id, then compare owner" — a single filter
// means there's no path where a missing check leaks another user's private chat, and an id
// belonging to someone else is simply indistinguishable from one that doesn't exist (404).

const MAX_TITLE = 80;

// Fallback name when auto-titling isn't possible (provider hiccup, or a title request that
// comes back empty). Better a truncated question than a list of identical "New chat" rows.
// A malformed id would otherwise reach Mongoose and throw a CastError, surfacing to the user
// as a generic 500 "something went wrong". A bad id is a client mistake, not a server fault,
// and it means the same thing as an id that doesn't exist — so both answer 404.
function invalidId(res, id) {
  if (mongoose.isValidObjectId(id)) return false;
  res.status(404).json({ success: false, message: 'Chat not found.' });
  return true;
}

function fallbackTitle(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return 'New chat';
  return oneLine.length > 48 ? `${oneLine.slice(0, 48).trimEnd()}…` : oneLine;
}

// GET /api/ai/chats — history list (titles + previews only, never message bodies)
exports.listAiChats = async (req, res) => {
  try {
    const convos = await AiConversation.find({ user: req.user._id })
      .sort({ lastMessageAt: -1 })
      .limit(200);
    return res.json({ success: true, conversations: convos.map((c) => c.toSummary()) });
  } catch (err) {
    console.error('[ai chat] list', err);
    return res.status(500).json({ success: false, message: 'Could not load your chat history.' });
  }
};

// GET /api/ai/chats/:id — one thread with its full message list
exports.getAiChat = async (req, res) => {
  try {
    if (invalidId(res, req.params.id)) return;
    const convo = await AiConversation.findOne({ _id: req.params.id, user: req.user._id });
    if (!convo) return res.status(404).json({ success: false, message: 'Chat not found.' });
    return res.json({
      success: true,
      conversation: convo.toSummary(),
      messages: convo.messages,
    });
  } catch (err) {
    console.error('[ai chat] get', err);
    return res.status(500).json({ success: false, message: 'Could not load that chat.' });
  }
};

// POST /api/ai/chats/:id/messages  { message } -> { conversation, messages, reply }
//
// :id may be the literal string 'new', which creates the thread as part of sending. That's
// why "New chat" in the UI doesn't hit the server at all — it just clears the open thread
// locally. The alternative (a POST that creates an empty document up front) would litter the
// history list with blank rows every time someone clicked New and then changed their mind.
exports.sendAiChatMessage = async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ success: false, message: 'Type a message first.' });
    }
    const text = message.trim();
    const isNew = req.params.id === 'new';

    let convo;
    if (isNew) {
      convo = new AiConversation({ user: req.user._id, messages: [] });
    } else {
      if (invalidId(res, req.params.id)) return;
      convo = await AiConversation.findOne({ _id: req.params.id, user: req.user._id });
      if (!convo) return res.status(404).json({ success: false, message: 'Chat not found.' });
    }

    // Full thread history, uncapped, is replayed as context on every turn (by request — see
    // models/AiConversation.js for the cost/latency/context-window trade-offs). Note this is
    // per-thread: other threads are never mixed in, which is what keeps separate chats
    // genuinely separate rather than just visually grouped.
    const context = convo.messages.map((m) => ({ role: m.role, content: m.content }));
    context.push({ role: 'user', content: text });

    const reply = await aiService.chat(context);

    convo.pushExchange(text, reply);

    // Auto-title on the first exchange only. Deliberately after the reply is in hand and
    // wrapped in its own try/catch: a naming failure must never turn a successful answer
    // into an error response, so it degrades to the truncated-question fallback instead.
    if (!convo.titleGenerated) {
      let title = '';
      try {
        title = await aiService.generateTitle({ userMessage: text, assistantMessage: reply });
      } catch (titleErr) {
        console.warn('[ai chat] auto-title failed, using fallback:', titleErr.message);
      }
      convo.title = (title || fallbackTitle(text)).slice(0, MAX_TITLE);
      convo.titleGenerated = true;
    }

    await convo.save();

    return res.json({
      success: true,
      reply,
      conversation: convo.toSummary(),
      messages: convo.messages,
    });
  } catch (err) {
    return handleAiError(res, err);
  }
};

// PATCH /api/ai/chats/:id  { title } — user rename.
// Also sets titleGenerated so the auto-titler can't later overwrite a name the user chose
// (relevant when someone renames a brand-new thread before its first reply lands).
exports.renameAiChat = async (req, res) => {
  try {
    if (invalidId(res, req.params.id)) return;
    const title = (req.body.title || '').trim();
    if (!title) return res.status(400).json({ success: false, message: 'Give the chat a name.' });

    const convo = await AiConversation.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { title: title.slice(0, MAX_TITLE), titleGenerated: true } },
      { new: true }
    );
    if (!convo) return res.status(404).json({ success: false, message: 'Chat not found.' });
    return res.json({ success: true, conversation: convo.toSummary() });
  } catch (err) {
    console.error('[ai chat] rename', err);
    return res.status(500).json({ success: false, message: 'Could not rename that chat.' });
  }
};

// DELETE /api/ai/chats/:id — delete a single thread
exports.deleteAiChat = async (req, res) => {
  try {
    if (invalidId(res, req.params.id)) return;
    const convo = await AiConversation.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!convo) return res.status(404).json({ success: false, message: 'Chat not found.' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[ai chat] delete', err);
    return res.status(500).json({ success: false, message: 'Could not delete that chat.' });
  }
};

// DELETE /api/ai/chats — wipe every AI thread for this user
exports.deleteAllAiChats = async (req, res) => {
  try {
    const { deletedCount } = await AiConversation.deleteMany({ user: req.user._id });
    return res.json({ success: true, deletedCount });
  } catch (err) {
    console.error('[ai chat] delete all', err);
    return res.status(500).json({ success: false, message: 'Could not clear your chat history.' });
  }
};
