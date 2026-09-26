const express = require('express');
const { body } = require('express-validator');
const { protect } = require('../middleware/auth');
const { requireNotSuspended } = require('../middleware/moderation');
const validate = require('../middleware/validate');
const { listLiveRooms, startLiveRoom, getLiveRoom, endLiveRoom } = require('../controllers/liveRoomController');

const router = express.Router();

router.get('/', protect, listLiveRooms);
router.post(
  '/',
  protect,
  requireNotSuspended,
  [body('title').trim().notEmpty().withMessage('Title is required')],
  validate,
  startLiveRoom
);
router.get('/:roomId', protect, getLiveRoom);
router.post('/:roomId/end', protect, endLiveRoom);

module.exports = router;
