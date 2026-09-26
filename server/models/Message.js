const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    type: { type: String, enum: ['text', 'image', 'video', 'voice', 'file', 'post'], default: 'text' },
    text: { type: String, maxlength: 4000 },
    media: { type: mongoose.Schema.Types.ObjectId, ref: 'Media' },
    // Set only when type === 'post' — a post shared into chat, rendered as a compact
    // card (thumbnail + caption + author) the same way replyTo/forwardedFrom render as
    // compact previews rather than duplicating the post's content into this document.
    sharedPost: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },

    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    forwardedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },

    reactions: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        emoji: String,
      },
    ],

    // One row per recipient — lets a group chat show individual delivery/read state per member.
    deliveredTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    isEdited: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false }, // soft delete — "Delete for everyone"
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
