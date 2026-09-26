const Notification = require('../models/Notification');

/**
 * Create a notification and push it in real time to the recipient (if they're online).
 * Silently no-ops when the recipient is the actor (no "you liked your own post" spam).
 *
 * @param {import('socket.io').Server} io
 * @param {object} params
 * @param {string} params.recipient - user id being notified
 * @param {string} params.actor - user id who triggered the notification
 * @param {string} params.type - one of the Notification model's enum values
 * @param {string} [params.post]
 * @param {string} [params.comment]
 * @param {string} [params.community]
 * @param {string} [params.event]
 * @param {string} [params.friendRequest]
 * @param {string} [params.text]
 */
async function notify(io, { recipient, actor, type, post, comment, community, event, friendRequest, text }) {
  try {
    if (String(recipient) === String(actor)) return null;

    const doc = await Notification.create({
      recipient,
      actor,
      type,
      post: post || null,
      comment: comment || null,
      community: community || null,
      event: event || null,
      friendRequest: friendRequest || null,
      text: text || '',
    });

    const populated = await doc.populate([
      { path: 'actor', select: 'name username avatarUrl' },
      { path: 'post', select: 'caption type media' },
      { path: 'community', select: 'name slug icon' },
      { path: 'event', select: 'name' },
      { path: 'friendRequest', select: 'status' },
    ]);

    if (io) {
      io.to(`user:${recipient}`).emit('notification:new', populated);
    }

    return populated;
  } catch (err) {
    // Notifications are a best-effort side effect — never let a failure here
    // break the like/comment/follow/etc. action that triggered it.
    console.error('[notify]', err);
    return null;
  }
}

module.exports = notify;
