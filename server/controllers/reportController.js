const Report = require('../models/Report');
const User = require('../models/User');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Message = require('../models/Message');
const Community = require('../models/Community');
const Event = require('../models/Event');

const MODELS_BY_TYPE = {
  user: User,
  post: Post,
  comment: Comment,
  message: Message,
  community: Community,
  event: Event,
};

// Each reportable type stores "who is responsible" under a different field name.
const OWNER_FIELD_BY_TYPE = {
  user: '_id',
  post: 'author',
  comment: 'author',
  message: 'sender',
  community: 'creator',
  event: 'organizer',
};

// POST /api/reports  { targetType, targetId, reason, details }
exports.createReport = async (req, res) => {
  try {
    const { targetType, targetId, reason, details } = req.body;

    const Model = MODELS_BY_TYPE[targetType];
    if (!Model) return res.status(400).json({ success: false, message: 'Invalid report target type' });

    const target = await Model.findById(targetId);
    if (!target) return res.status(404).json({ success: false, message: 'The reported content no longer exists' });

    const ownerField = OWNER_FIELD_BY_TYPE[targetType];
    const targetOwner = target[ownerField];

    if (String(targetOwner) === String(req.user._id)) {
      return res.status(400).json({ success: false, message: "You can't report your own content" });
    }

    const report = await Report.create({
      reporter: req.user._id,
      targetType,
      target: targetId,
      targetOwner,
      reason,
      details: details || '',
    });

    return res.status(201).json({ success: true, report });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "You've already reported this — our team is reviewing it.",
      });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('[createReport]', err);
    return res.status(500).json({ success: false, message: 'Could not submit report' });
  }
};

// GET /api/reports?status=open&page=1 — moderator queue
exports.listReports = async (req, res) => {
  try {
    const status = req.query.status || 'open';
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    const query = status === 'all' ? {} : { status };

    const [reports, total] = await Promise.all([
      Report.find(query)
        .sort('-createdAt')
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('reporter', 'name username avatarUrl')
        .populate('targetOwner', 'name username avatarUrl isSuspended')
        .populate('reviewedBy', 'name username'),
      Report.countDocuments(query),
    ]);

    // Resolve each report's actual subject so the queue can show what's being reported
    // without the moderator having to click through blind.
    const withTargets = await Promise.all(
      reports.map(async (r) => {
        const Model = MODELS_BY_TYPE[r.targetType];
        let preview = null;
        try {
          const target = await Model.findById(r.target).select('caption text name username content');
          if (target) {
            preview =
              target.caption || target.text || target.name || target.username || target.content || null;
          }
        } catch {
          /* target may have been deleted since — preview stays null, report still shows */
        }
        return { ...r.toObject(), targetPreview: preview, targetExists: preview !== null };
      })
    );

    return res.json({
      success: true,
      reports: withTargets,
      page,
      totalPages: Math.ceil(total / limit),
      total,
    });
  } catch (err) {
    console.error('[listReports]', err);
    return res.status(500).json({ success: false, message: 'Could not load reports' });
  }
};

// GET /api/reports/stats — small summary for the moderation dashboard header
exports.getReportStats = async (req, res) => {
  try {
    const counts = await Report.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    const stats = { open: 0, reviewing: 0, actioned: 0, dismissed: 0 };
    counts.forEach((c) => {
      stats[c._id] = c.count;
    });
    return res.json({ success: true, stats });
  } catch (err) {
    console.error('[getReportStats]', err);
    return res.status(500).json({ success: false, message: 'Could not load report stats' });
  }
};

// PUT /api/reports/:reportId  { status, action, moderatorNote, suspendDays }
// action: 'none' | 'deleteContent' | 'suspendUser'
exports.resolveReport = async (req, res) => {
  try {
    const { status, action = 'none', moderatorNote, suspendDays } = req.body;

    const report = await Report.findById(req.params.reportId);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found' });

    if (action === 'deleteContent') {
      const Model = MODELS_BY_TYPE[report.targetType];
      if (report.targetType === 'user') {
        return res.status(400).json({
          success: false,
          message: "Can't delete a user as content — use suspendUser instead",
        });
      }
      // Soft-delete where the model supports it (keeps reply threads intact), hard-delete
      // otherwise.
      const target = await Model.findById(report.target);
      if (target) {
        if ('isDeleted' in target) {
          target.isDeleted = true;
          if ('text' in target) target.text = '';
          await target.save();
        } else {
          await target.deleteOne();
        }
      }
    }

    if (action === 'suspendUser' && report.targetOwner) {
      const days = Number(suspendDays) || 7;
      await User.findByIdAndUpdate(report.targetOwner, {
        isSuspended: true,
        suspendedUntil: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
        suspensionReason: moderatorNote || `Reported for ${report.reason}`,
      });
    }

    report.status = status || 'actioned';
    report.reviewedBy = req.user._id;
    report.reviewedAt = new Date();
    if (moderatorNote !== undefined) report.moderatorNote = moderatorNote;
    await report.save();

    return res.json({ success: true, report });
  } catch (err) {
    console.error('[resolveReport]', err);
    return res.status(500).json({ success: false, message: 'Could not resolve report' });
  }
};

// POST /api/reports/:reportId/unsuspend — lift a suspension early
exports.unsuspendUser = async (req, res) => {
  try {
    const report = await Report.findById(req.params.reportId);
    if (!report?.targetOwner) {
      return res.status(404).json({ success: false, message: 'Report or reported user not found' });
    }

    await User.findByIdAndUpdate(report.targetOwner, {
      isSuspended: false,
      suspendedUntil: null,
      suspensionReason: '',
    });

    return res.json({ success: true, message: 'Suspension lifted' });
  } catch (err) {
    console.error('[unsuspendUser]', err);
    return res.status(500).json({ success: false, message: 'Could not lift suspension' });
  }
};
