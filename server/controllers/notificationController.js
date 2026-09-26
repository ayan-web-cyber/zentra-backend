const Notification = require('../models/Notification');

// GET /api/notifications?cursor=&limit=
exports.listNotifications = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const query = { recipient: req.user._id };
    if (req.query.cursor) {
      query._id = { $lt: req.query.cursor };
    }

    const notifications = await Notification.find(query)
      .sort({ _id: -1 })
      .limit(limit)
      .populate('actor', 'name username avatarUrl')
      .populate('post', 'caption type media')
      .populate('community', 'name slug icon')
      .populate('event', 'name')
      .populate('friendRequest', 'status');

    const unreadCount = await Notification.countDocuments({ recipient: req.user._id, isRead: false });
    const nextCursor = notifications.length === limit ? notifications[notifications.length - 1]._id : null;

    return res.json({ success: true, notifications, unreadCount, nextCursor });
  } catch (err) {
    console.error('[listNotifications]', err);
    return res.status(500).json({ success: false, message: 'Could not load notifications' });
  }
};

// GET /api/notifications/unread-count
exports.getUnreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({ recipient: req.user._id, isRead: false });
    return res.json({ success: true, count });
  } catch (err) {
    console.error('[getUnreadCount]', err);
    return res.status(500).json({ success: false, message: 'Could not load unread count' });
  }
};

// PATCH /api/notifications/:id/read
exports.markRead = async (req, res) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user._id },
      { isRead: true },
      { new: true }
    );
    if (!notif) return res.status(404).json({ success: false, message: 'Notification not found' });
    return res.json({ success: true, notification: notif });
  } catch (err) {
    console.error('[markRead]', err);
    return res.status(500).json({ success: false, message: 'Could not update notification' });
  }
};

// PATCH /api/notifications/read-all
exports.markAllRead = async (req, res) => {
  try {
    await Notification.updateMany({ recipient: req.user._id, isRead: false }, { isRead: true });
    return res.json({ success: true });
  } catch (err) {
    console.error('[markAllRead]', err);
    return res.status(500).json({ success: false, message: 'Could not update notifications' });
  }
};

// DELETE /api/notifications/:id
exports.deleteNotification = async (req, res) => {
  try {
    const notif = await Notification.findOneAndDelete({ _id: req.params.id, recipient: req.user._id });
    if (!notif) return res.status(404).json({ success: false, message: 'Notification not found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[deleteNotification]', err);
    return res.status(500).json({ success: false, message: 'Could not delete notification' });
  }
};

// DELETE /api/notifications
exports.clearAll = async (req, res) => {
  try {
    await Notification.deleteMany({ recipient: req.user._id });
    return res.json({ success: true });
  } catch (err) {
    console.error('[clearAll]', err);
    return res.status(500).json({ success: false, message: 'Could not clear notifications' });
  }
};
