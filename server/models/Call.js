const mongoose = require('mongoose');

const callSchema = new mongoose.Schema(
  {
    caller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    callee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['voice', 'video'], required: true },
    status: {
      type: String,
      enum: ['ringing', 'accepted', 'rejected', 'missed', 'ended'],
      default: 'ringing',
    },
    startedAt: { type: Date }, // set when accepted
    endedAt: { type: Date },
    durationSeconds: { type: Number, default: 0 },
  },
  { timestamps: true }
);

callSchema.index({ caller: 1, createdAt: -1 });
callSchema.index({ callee: 1, createdAt: -1 });

module.exports = mongoose.model('Call', callSchema);
