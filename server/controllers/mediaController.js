const { Readable } = require('stream');
const mongoose = require('mongoose');
const { getBucket } = require('../config/gridfs');
const Media = require('../models/Media');

// Streams a buffered upload into GridFS and records the metadata pointer.
// kind ('avatar' | 'cover' | 'post' | 'story' | 'voice' | 'message' | ...) is passed
// by the calling route so callers (profile update, post composer, etc.) share this
// one upload path instead of duplicating GridFS logic per feature.
async function saveBufferToGridFS({ buffer, filename, mimeType, ownerId, kind }) {
  const bucket = getBucket();

  const gridfsId = await new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, {
      contentType: mimeType,
      metadata: { ownerId, kind },
    });
    Readable.from(buffer)
      .pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => resolve(uploadStream.id));
  });

  const media = await Media.create({
    owner: ownerId,
    gridfsId,
    filename,
    mimeType,
    size: buffer.length,
    kind,
  });

  return media;
}

// POST /api/media/upload  (multipart/form-data, field name "file", plus body.kind)
exports.uploadMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided' });
    }
    const kind = req.body.kind || 'post';

    const media = await saveBufferToGridFS({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      ownerId: req.user._id,
      kind,
    });

    return res.status(201).json({
      success: true,
      media: { id: media._id, url: media.toUrl(), mimeType: media.mimeType, size: media.size, kind: media.kind },
    });
  } catch (err) {
    console.error('[uploadMedia]', err);
    return res.status(500).json({ success: false, message: 'Upload failed' });
  }
};

// GET /api/media/:gridfsId — streams the file back, with HTTP range support for video/audio scrubbing
exports.streamMedia = async (req, res) => {
  try {
    const { gridfsId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(gridfsId)) {
      return res.status(400).json({ success: false, message: 'Invalid media id' });
    }
    const _id = new mongoose.Types.ObjectId(gridfsId);
    const bucket = getBucket();

    const files = await bucket.find({ _id }).toArray();
    if (!files.length) {
      return res.status(404).json({ success: false, message: 'Media not found' });
    }
    const file = files[0];
    const range = req.headers.range;

    res.set('Content-Type', file.contentType || 'application/octet-stream');
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : file.length - 1;

      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${file.length}`);
      res.set('Content-Length', end - start + 1);

      bucket.openDownloadStream(_id, { start, end: end + 1 }).pipe(res);
    } else {
      res.set('Content-Length', file.length);
      bucket.openDownloadStream(_id).pipe(res);
    }
  } catch (err) {
    console.error('[streamMedia]', err);
    return res.status(500).json({ success: false, message: 'Could not load media' });
  }
};

// DELETE /api/media/:mediaId — removes both the metadata doc and the GridFS file, owner-only
exports.deleteMedia = async (req, res) => {
  try {
    const media = await Media.findById(req.params.mediaId);
    if (!media) return res.status(404).json({ success: false, message: 'Media not found' });
    if (String(media.owner) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this media' });
    }

    const bucket = getBucket();
    await bucket.delete(media.gridfsId).catch(() => null); // already-gone chunks shouldn't block metadata cleanup
    await media.deleteOne();

    return res.json({ success: true, message: 'Media deleted' });
  } catch (err) {
    console.error('[deleteMedia]', err);
    return res.status(500).json({ success: false, message: 'Delete failed' });
  }
};

exports.saveBufferToGridFS = saveBufferToGridFS;
