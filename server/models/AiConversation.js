const mongoose = require('mongoose');

// One document per AI CONVERSATION (not per user — that was the old shape). A user can now
// have many named threads, listed in the AI Chat history panel, so `user` is a plain
// non-unique index and the compound index below is what the list query actually rides on.
//
// NOTE on upgrading an existing database: the previous version of this schema had
// `user: { unique: true }`. Mongoose's autoIndex would NOT have removed that stale unique
// index on its own, and it would have kept rejecting every second conversation a user
// created. config/db.js already calls Model.syncIndexes() for every model on startup, which
// reconciles the database's indexes against this schema — so the old unique index is dropped
// automatically the first time the server boots with this file. Nothing manual to run.
//
// Conversations stay separate from Conversation/Message (which are user-to-user) so it's
// obvious this content never touches the social graph: no other user, community, or
// moderator queue ever sees it.
//
// No cap on stored messages or on how much gets replayed to the model per turn (by request
// — see aiController.js, which sends a thread's full history every time). Two real
// consequences: cost/latency grow with thread length since every past message is billed and
// processed again on each turn, and a long enough thread will eventually exceed the
// provider's own context-window limit — that ceiling lives on Anthropic's/Groq's side and
// can't be raised from here. Starting a new chat is now the natural fix for both, which is
// part of why multiple threads are worth having.

const aiMessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true, maxlength: 8000 },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

const aiConversationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Shown in the history list. Seeded as 'New chat', then replaced once — automatically,
    // by the model itself — after the first exchange (see aiController.sendAiChatMessage).
    title: { type: String, trim: true, default: 'New chat', maxlength: 80 },

    // Guards the auto-title so it happens exactly once per thread. It's also what makes a
    // user's manual rename permanent: renaming sets this true, so a later turn never
    // overwrites a name the user chose themselves.
    titleGenerated: { type: Boolean, default: false },

    messages: { type: [aiMessageSchema], default: [] },

    // Denormalised sort key for the history list. Kept in step with messages by
    // pushExchange() below. Using this instead of `updatedAt` means a rename doesn't
    // reshuffle the list — only actual conversation activity does.
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Drives the history panel: this user's threads, most recently active first.
aiConversationSchema.index({ user: 1, lastMessageAt: -1 });

aiConversationSchema.methods.pushExchange = function pushExchange(userText, assistantText) {
  this.messages.push({ role: 'user', content: userText });
  this.messages.push({ role: 'assistant', content: assistantText });
  this.lastMessageAt = new Date();
};

// What the history list needs — deliberately excludes `messages`, which can be large and is
// only ever loaded when a specific thread is opened.
aiConversationSchema.methods.toSummary = function toSummary() {
  const last = this.messages[this.messages.length - 1];
  return {
    _id: this._id,
    title: this.title,
    messageCount: this.messages.length,
    preview: last ? last.content.slice(0, 120) : '',
    lastMessageAt: this.lastMessageAt,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('AiConversation', aiConversationSchema);
