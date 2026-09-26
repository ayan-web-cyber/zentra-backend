const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: '', maxlength: 2000 },
    cover: { type: mongoose.Schema.Types.ObjectId, ref: 'Media', default: null },

    startAt: { type: Date, required: true },
    endAt: { type: Date, default: null },

    isOnline: { type: Boolean, default: false },
    location: { type: String, default: '', maxlength: 200 }, // physical address, or a meeting link when isOnline

    organizer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', default: null, index: true },

    interested: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    going: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

eventSchema.index({ startAt: 1 });

module.exports = mongoose.model('Event', eventSchema);
