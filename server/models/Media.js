const mongoose = require('mongoose');

// GridFS (fs.files / fs.chunks in the "media" bucket) holds the actual bytes.
// This document is the app-facing metadata pointer described in section 43 of the spec:
// owner, type, size, and created time, plus what the media is used for.
const mediaSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    gridfsId: { type: mongoose.Schema.Types.ObjectId, required: true }, // id in fs.files
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true }, // bytes
    kind: {
      type: String,
      enum: ['avatar', 'cover', 'post', 'story', 'voice', 'message', 'community', 'event'],
      required: true,
    },
  },
  { timestamps: true }
);

mediaSchema.methods.toUrl = function toUrl() {
  return `/api/media/${this.gridfsId}`;
};

module.exports = mongoose.model('Media', mediaSchema);
