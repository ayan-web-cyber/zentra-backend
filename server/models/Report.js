const mongoose = require('mongoose');

// One model covers every reportable thing (section 40) rather than a table per type —
// targetType + target is enough to resolve the subject, and it keeps the moderation queue
// a single sorted list instead of something that has to merge several collections.
const REPORT_REASONS = [
  'spam',
  'harassment',
  'hateSpeech',
  'violence',
  'nudity',
  'misinformation',
  'selfHarm',
  'impersonation',
  'other',
];

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    targetType: {
      type: String,
      enum: ['user', 'post', 'comment', 'message', 'community', 'event'],
      required: true,
    },
    // Not a hard ref to one collection — targetType says which one it points at.
    target: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    // Denormalized so the queue can show "who is responsible for this content" without
    // resolving the target first, and so it survives the target being deleted.
    targetOwner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    reason: { type: String, enum: REPORT_REASONS, required: true },
    details: { type: String, maxlength: 1000, default: '' },

    status: {
      type: String,
      enum: ['open', 'reviewing', 'actioned', 'dismissed'],
      default: 'open',
      index: true,
    },
    // Filled in when a moderator resolves it — kept for an audit trail rather than
    // deleting the report row.
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    moderatorNote: { type: String, maxlength: 1000, default: '' },
  },
  { timestamps: true }
);

// One open report per person per thing — stops a single user spamming the queue by
// repeatedly reporting the same post, while still allowing a fresh report later if an
// earlier one was already resolved.
reportSchema.index(
  { reporter: 1, targetType: 1, target: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['open', 'reviewing'] } } }
);
reportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Report', reportSchema);
module.exports.REPORT_REASONS = REPORT_REASONS;
