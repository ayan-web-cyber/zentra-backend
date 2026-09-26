// Gates the moderation queue. Kept separate from `protect` so that being logged in and
// being allowed to action reports stay distinct checks.
const requireModerator = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  if (req.user.role !== 'moderator' && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Moderator access required' });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
};

// Applied to content-creating routes. A suspended user can still read and log in — they're
// just stopped from posting/commenting/messaging until the suspension lapses. Expired
// suspensions clear themselves on the next request rather than needing a scheduled job.
const requireNotSuspended = async (req, res, next) => {
  if (!req.user) return next();

  if (req.user.isSuspended) {
    const expired = req.user.suspendedUntil && req.user.suspendedUntil <= new Date();
    if (expired) {
      req.user.isSuspended = false;
      req.user.suspendedUntil = null;
      req.user.suspensionReason = '';
      await req.user.save();
      return next();
    }

    return res.status(403).json({
      success: false,
      message: req.user.suspensionReason
        ? `Your account is suspended: ${req.user.suspensionReason}`
        : 'Your account is currently suspended.',
      suspendedUntil: req.user.suspendedUntil,
    });
  }

  next();
};

module.exports = { requireModerator, requireAdmin, requireNotSuspended };
