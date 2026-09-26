const mongoose = require('mongoose');

const postSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    coAuthors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // collaborative posts (section 35)
    taggedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // explicit "tag people" on the post
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // @usernames parsed out of the caption
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', default: null, index: true }, // set when posted into a community feed
    type: {
      type: String,
      enum: ['text', 'photo', 'video', 'multiPhoto', 'poll', 'voice', 'music'],
      required: true,
    },
    isReel: { type: Boolean, default: false }, // a video post shown in the vertical /reels feed
    caption: { type: String, maxlength: 2000, default: '' },
    media: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Media' }], // one or more, e.g. multi-photo posts
    // Reuses the existing Song library (see Song.js / songController.js — already powers the
    // Story music picker) rather than a second song catalog. Only set when type === 'music'.
    song: { type: mongoose.Schema.Types.ObjectId, ref: 'Song', default: null },
    mood: { type: String, default: '' }, // e.g. "Happy", "Excited" — section 33

    poll: {
      question: { type: String },
      options: [
        {
          text: String,
          votes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
        },
      ],
    },

    visibility: {
      type: String,
      enum: ['everyone', 'followers', 'friends', 'onlyMe'],
      default: 'everyone',
    },

    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    commentCount: { type: Number, default: 0 },
    shareCount: { type: Number, default: 0 },

    isEdited: { type: Boolean, default: false },
  },
  { timestamps: true }
);

postSchema.index({ createdAt: -1 });
postSchema.index({ author: 1, createdAt: -1 });

module.exports = mongoose.model('Post', postSchema);
