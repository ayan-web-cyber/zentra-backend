const express = require('express');
const { protect } = require('../middleware/auth');
const { search } = require('../controllers/searchController');

const router = express.Router();

router.get('/', protect, search);

module.exports = router;
