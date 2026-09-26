const multer = require('multer');

const MAX_SIZE_MB = Number(process.env.MAX_UPLOAD_SIZE_MB || 25);

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/webm',
  'audio/ogg',
  'audio/wav',
]);

// Generic "file" chat attachments (section 9 of the remaining-features spec) — kept as a
// SEPARATE, narrower whitelist from ALLOWED_MIME above rather than merged into it, so the
// distinction between "media" uploads (avatar/post/story/voice) and "document" chat
// attachments stays explicit at the call site. Deliberately excludes anything executable
// or script-like (.exe, .sh, .bat, .msi, .apk, .js, ...) — this is a document/archive
// whitelist, not "anything goes".
const ALLOWED_DOCUMENT_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
]);

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME.has(file.mimetype) && !ALLOWED_DOCUMENT_MIME.has(file.mimetype)) {
    return cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
  }
  cb(null, true);
};

// Buffered in memory, then streamed straight into GridFS by mediaController —
// never written to local disk, never embedded in a normal Mongo document.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
  fileFilter,
});

module.exports = upload;
