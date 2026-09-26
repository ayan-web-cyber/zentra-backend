const mongoose = require('mongoose');

// Mirrors SavedPost.js exactly — a per-user relation, not a flag on the post itself, so
// hiding a post for one viewer never touches the post document other users (including its
// author) still see. "Hidden" only ever means "excluded from *my* feed query."
const hiddenPostSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
  },
  { timestamps: true }
);

hiddenPostSchema.index({ user: 1, post: 1 }, { unique: true });

module.exports = mongoose.model('HiddenPost', hiddenPostSchema);
