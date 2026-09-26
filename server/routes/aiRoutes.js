const express = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { protect } = require('../middleware/auth');
const { requireNotSuspended } = require('../middleware/moderation');
const validate = require('../middleware/validate');
const {
  getAiStatus,
  suggestCaptions,
  rewriteCaption,
  translateCaption,
  listAiChats,
  getAiChat,
  sendAiChatMessage,
  renameAiChat,
  deleteAiChat,
  deleteAllAiChats,
} = require('../controllers/aiController');

const router = express.Router();

// AI calls are comparatively expensive (latency + cost against a real provider once
// configured), so they get their own tight limiter separate from the general API cap.
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AI_RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many AI requests — please slow down and try again shortly.' },
});

router.get('/status', protect, getAiStatus);

router.post(
  '/caption',
  protect,
  requireNotSuspended,
  aiLimiter,
  [body('description').trim().notEmpty().withMessage('Description is required')],
  validate,
  suggestCaptions
);

router.post(
  '/rewrite',
  protect,
  requireNotSuspended,
  aiLimiter,
  [body('text').trim().notEmpty().withMessage('Text is required')],
  validate,
  rewriteCaption
);

router.post(
  '/translate',
  protect,
  requireNotSuspended,
  aiLimiter,
  [body('text').trim().notEmpty(), body('targetLanguage').trim().notEmpty()],
  validate,
  translateCaption
);

// AI Chat ("ask anything") — deliberately NOT gated by requireNotSuspended. Suspension
// blocks posting/commenting/messaging where other users would see the content; this chat
// is private between the user and the AI, so a suspended account can still use it (same
// principle as still being able to read the feed while suspended).
//
// A user has many named threads. Only the send route burns provider quota, so only that one
// carries aiLimiter — putting the limiter on the list/open/rename/delete routes would mean
// simply browsing your own history could lock you out of asking questions.
router.get('/chats', protect, listAiChats);
router.delete('/chats', protect, deleteAllAiChats);

router.get('/chats/:id', protect, getAiChat);

// :id accepts the literal 'new' to create the thread as part of the first send — see the
// controller for why New Chat is a client-side action rather than a create endpoint.
router.post(
  '/chats/:id/messages',
  protect,
  aiLimiter,
  [body('message').trim().notEmpty().withMessage('Message is required')],
  validate,
  sendAiChatMessage
);

router.patch(
  '/chats/:id',
  protect,
  [body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 80 })],
  validate,
  renameAiChat
);

router.delete('/chats/:id', protect, deleteAiChat);

module.exports = router;
