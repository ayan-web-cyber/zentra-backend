const express = require('express');
const { protect, optionalAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { uploadMedia, streamMedia, deleteMedia } = require('../controllers/mediaController');

const router = express.Router();

router.post('/upload', protect, upload.single('file'), uploadMedia);
// Streaming is left on optionalAuth rather than protect: privacy (who can view a given
// piece of media) is enforced by the feature that owns it (post/story/profile) when it
// hands out the URL, not by this generic streaming endpoint.
router.get('/:gridfsId', optionalAuth, streamMedia);
router.delete('/:mediaId', protect, deleteMedia);

module.exports = router;
