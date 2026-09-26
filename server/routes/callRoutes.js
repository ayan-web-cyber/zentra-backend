const express = require('express');
const { protect } = require('../middleware/auth');
const { getCallHistory, getIceServers } = require('../controllers/callController');

const router = express.Router();

router.get('/', protect, getCallHistory);
router.get('/ice-servers', protect, getIceServers);

module.exports = router;
