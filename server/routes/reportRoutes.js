const express = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { protect } = require('../middleware/auth');
const { requireModerator } = require('../middleware/moderation');
const validate = require('../middleware/validate');
const {
  createReport,
  listReports,
  getReportStats,
  resolveReport,
  unsuspendUser,
} = require('../controllers/reportController');
const { REPORT_REASONS } = require('../models/Report');

const router = express.Router();

// Reporting is a low-frequency action by nature — a much tighter limit than the general
// API cap, so the moderation queue can't be flooded from one account.
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many reports submitted — please try again later.' },
});

router.post(
  '/',
  protect,
  reportLimiter,
  [
    body('targetType').isIn(['user', 'post', 'comment', 'message', 'community', 'event']),
    body('targetId').isMongoId().withMessage('Invalid target id'),
    body('reason').isIn(REPORT_REASONS).withMessage('Invalid report reason'),
    body('details').optional().isLength({ max: 1000 }),
  ],
  validate,
  createReport
);

// --- Moderator-only from here down ---
router.get('/', protect, requireModerator, listReports);
router.get('/stats', protect, requireModerator, getReportStats);
router.put('/:reportId', protect, requireModerator, resolveReport);
router.post('/:reportId/unsuspend', protect, requireModerator, unsuspendUser);

module.exports = router;
