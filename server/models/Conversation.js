const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
    isGroup: { type: Boolean, default: false },

    // Set only for a community's auto-created group chat (see communityController's
    // openCommunityChat). Lets leaveConversation and deleteCommunity tell a "real" standalone
    // group apart from a community's chat, where deleting/leaving the CHAT must not remove the
    // person's COMMUNITY membership.
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', default: null },

    // Group-only fields (section 29)
    groupName: { type: String, trim: true, maxlength: 50 },
    groupImageUrl: { type: String },
    admins: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    lastMessage: {
      text: String,
      sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      sentAt: Date,
    },

    // Per-user "cleared/left" bookkeeping so a left group doesn't vanish for everyone else
    leftBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // Who has muted this conversation — mute is a per-user preference, not shared.
    mutedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // Chat wallpaper/bubble theme — shared across the conversation, like most chat apps.
    theme: { type: String, enum: ['aurora', 'sunset', 'ocean', 'forest', 'candy'], default: 'aurora' },

    // Per-user "clear chat" — hides everything sent before clearedAt for that user only,
    // without touching the other participant's view or deleting any messages.
    clearedBy: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        clearedAt: { type: Date },
      },
    ],
  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1, updatedAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
