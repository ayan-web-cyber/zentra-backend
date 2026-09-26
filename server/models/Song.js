const mongoose = require('mongoose');

// A small in-house "sound library" that powers the music picker in the Story
// composer (section: stories should support adding trending songs, with or
// without keeping the clip's original audio). In production this is the model
// a licensed music-catalog integration (e.g. a commercial sound library API)
// would populate; for now it is seeded with royalty-free demo tracks — see
// server/utils/seedSongs.js — so the feature works end-to-end out of the box.
const songSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    artist: { type: String, required: true, trim: true },
    audioUrl: { type: String, required: true }, // streamable URL (external CDN or /api/media/:id)
    coverColor: { type: String, default: '#7C3AED' }, // used for the picker's cover swatch (no cover art needed)
    duration: { type: Number, default: 30 }, // seconds available for use in a story
    category: {
      type: String,
      enum: ['trending', 'pop', 'hiphop', 'chill', 'mood', 'original'],
      default: 'trending',
    },
    // Bumped every time a story is published with this song attached.
    // Sorting by this is what makes the "Trending" tab actually reflect trends.
    usageCount: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

songSchema.index({ title: 'text', artist: 'text' });

module.exports = mongoose.model('Song', songSchema);
