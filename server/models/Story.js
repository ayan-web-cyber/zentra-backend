const mongoose = require('mongoose');

const storySchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['photo', 'video', 'text', 'voice'], required: true },
    media: { type: mongoose.Schema.Types.ObjectId, ref: 'Media' }, // photo/video/voice stories
    textContent: { type: String, maxlength: 200 }, // text stories (full-screen text, no media)
    backgroundColor: { type: String, default: '#7C3AED' }, // text story background

    caption: { type: String, maxlength: 300 }, // optional caption shown over a photo/video/voice story

    // Optional single text overlay drawn on top of a photo/video story
    // (separate from `textContent`, which *is* the story for type "text").
    textOverlay: {
      text: { type: String, maxlength: 120 },
      color: { type: String, default: '#FFFFFF' },
      position: { type: String, enum: ['top', 'center', 'bottom'], default: 'center' },
    },

    // Optional attached song. Title/artist/audioUrl are snapshotted at post time
    // so a story keeps playing the right track even if the catalog changes later;
    // `song` keeps the reference for analytics (and so usageCount can be bumped).
    song: {
      song: { type: mongoose.Schema.Types.ObjectId, ref: 'Song' },
      title: String,
      artist: String,
      audioUrl: String,
      startTime: { type: Number, default: 0 }, // seconds into the track to start playback
      // Videos only: if true, the clip's own audio keeps playing alongside the song.
      // If false (default when a song is attached), the clip's original audio is muted.
      keepOriginalAudio: { type: Boolean, default: false },
    },

    viewers: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        viewedAt: { type: Date, default: Date.now },
      },
    ],

    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true }
);

// TTL index — MongoDB automatically deletes the document once expiresAt passes,
// which is what actually implements the "stories expire after 24 hours" requirement.
storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
storySchema.index({ author: 1, createdAt: -1 });

module.exports = mongoose.model('Story', storySchema);
