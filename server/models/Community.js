const mongoose = require('mongoose');

const communitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, unique: true, lowercase: true, index: true },
    description: { type: String, default: '', maxlength: 500 },
    icon: { type: String, default: '💬' }, // emoji fallback, always renders even with no cover image
    category: {
      type: String,
      enum: [
        'Technology',
        'Gaming',
        'Photography',
        'Music',
        'Sports',
        'Travel',
        'Education',
        'Art',
        'Food',
        'Fitness',
        'Business',
        'Other',
      ],
      default: 'Other',
    },
    privacy: { type: String, enum: ['public', 'private'], default: 'public' },

    cover: { type: mongoose.Schema.Types.ObjectId, ref: 'Media', default: null },
    avatar: { type: mongoose.Schema.Types.ObjectId, ref: 'Media', default: null },

    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    moderators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // Kept alongside `members` (rather than turning members into subdocuments) so every
    // existing `members.some(id => ...)` / `participants: community.members` call site keeps
    // working untouched. Only used to enforce the "leave 24h after joining" rule below.
    memberJoinedAt: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        joinedAt: { type: Date, default: Date.now },
      },
    ],

    // Admin-sent invitations that haven't been accepted/declined yet. A user only becomes a
    // member (and moves into `members`/`memberJoinedAt`) once they accept.
    pendingInvites: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        invitedAt: { type: Date, default: Date.now },
      },
    ],

    // Conversation created lazily the first time someone opens "Community chat" —
    // kept on the community so every member reopens the same group thread.
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
  },
  { timestamps: true }
);

communitySchema.index({ name: 'text', description: 'text' });
communitySchema.index({ category: 1, createdAt: -1 });

module.exports = mongoose.model('Community', communitySchema);
