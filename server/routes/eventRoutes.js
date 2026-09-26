const express = require('express');
const { body } = require('express-validator');
const { protect, optionalAuth } = require('../middleware/auth');
const validate = require('../middleware/validate');
const {
  listEvents,
  createEvent,
  getEvent,
  updateEvent,
  deleteEvent,
  rsvpEvent,
} = require('../controllers/eventController');

const router = express.Router();

router.get('/', optionalAuth, listEvents);
router.post(
  '/',
  protect,
  [body('name').trim().notEmpty().withMessage('Event name is required'), body('startAt').notEmpty().withMessage('Start date/time is required')],
  validate,
  createEvent
);

router.get('/:eventId', optionalAuth, getEvent);
router.put('/:eventId', protect, updateEvent);
router.delete('/:eventId', protect, deleteEvent);
router.post('/:eventId/rsvp', protect, [body('status').isIn(['interested', 'going', 'not_interested'])], validate, rsvpEvent);

module.exports = router;
