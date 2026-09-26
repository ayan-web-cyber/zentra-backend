const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: [
        'like',
        'comment',
        'follow',
        'friendRequest',
        'friendAccept',
        'mention',
        'message',
        'call',
        'missedCall',
        'communityInvite',
        'eventReminder',
      ],
      required: true,
    },
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },
    comment: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', default: null },
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', default: null },
    // Only set on 'friendRequest' notifications — lets the Activity page render Confirm/Reject
    // buttons that act on the right FriendRequest document without a second lookup.
    friendRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'FriendRequest', default: null },
    text: { type: String, default: '' }, // optional extra context, e.g. a comment preview
    isRead: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
