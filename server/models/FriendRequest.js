const mongoose = require('mongoose');

const friendRequestSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  },
  { timestamps: true }
);

// Only enforces uniqueness among *pending* requests — without the partial filter, a single
// rejected (or accepted-then-unfriended) request between the same two people would permanently
// block any future request in that direction with an unhandled duplicate-key error.
friendRequestSchema.index({ from: 1, to: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });

module.exports = mongoose.model('FriendRequest', friendRequestSchema);
