const mongoose = require('mongoose');

// Section 36 — Live Rooms. Deliberately kept simple for this first implementation: a
// single host publishes mic/cam, and each viewer gets a direct receive-only connection to
// that host (one-to-many, not a mesh) rather than a full SFU-backed broadcast — the master
// spec explicitly calls for architecture that CAN grow into that later, not a production
// live-streaming stack on day one. See sockets/index.js liveroom:* handlers for the
// signaling side, and client/src/pages/LiveRoomView.jsx for the peer-connection topology.
const liveRoomSchema = new mongoose.Schema(
  {
    host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', default: null, index: true },

    status: { type: String, enum: ['live', 'ended'], default: 'live', index: true },

    // Kept in sync from the socket layer (join/leave), not the source of truth for "who's
    // in the room right now" — that lives in the in-memory room map next to activeCalls,
    // same pattern the Call feature uses. This field is the durable record for call
    // history / room summaries after the room ends.
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    peakViewers: { type: Number, default: 0 },

    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

liveRoomSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('LiveRoom', liveRoomSchema);
