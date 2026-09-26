const express = require('express');
const { protect } = require('../middleware/auth');
const { getExplore } = require('../controllers/exploreController');

const router = express.Router();

router.get('/', protect, getExplore);

module.exports = router;
