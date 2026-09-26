const express = require('express');
const { protect } = require('../middleware/auth');
const {
  sendRequest,
  cancelRequest,
  acceptRequest,
  rejectRequest,
  removeFriend,
  listIncomingRequests,
} = require('../controllers/friendController');

const router = express.Router();

router.get('/requests', protect, listIncomingRequests);
router.post('/request/:username', protect, sendRequest);
router.delete('/request/:username', protect, cancelRequest);
router.post('/:requestId/accept', protect, acceptRequest);
router.post('/:requestId/reject', protect, rejectRequest);
router.delete('/:username', protect, removeFriend);

module.exports = router;
