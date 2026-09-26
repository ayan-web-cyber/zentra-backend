const express = require('express');
const { protect } = require('../middleware/auth');
const { getTrendingSongs, searchSongs } = require('../controllers/songController');

const router = express.Router();

// Both endpoints require auth like the rest of the app's data endpoints —
// the sound library isn't public marketing content, it's part of the composer.
router.get('/trending', protect, getTrendingSongs);
router.get('/', protect, searchSongs);

module.exports = router;
