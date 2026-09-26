const socketAuth = require('./socketAuth');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Media = require('../models/Media');
const User = require('../models/User');
const Call = require('../models/Call');
const LiveRoom = require('../models/LiveRoom');
const notify = require('../utils/notify');
const { serializeMessage } = require('../controllers/messageController');
const { isBlockedPair } = require('../controllers/conversationController');

// userId -> Set of socket.ids. In-memory, per-process — fine for a single Node instance;
// scaling to multiple instances would move this to Redis (and add the socket.io Redis
// adapter) so presence and room broadcasts work across processes.
const onlineSockets = new Map();

// callId -> { callerId, calleeId, status }. In-memory, per-process, mirroring onlineSockets
// above — lets disconnect handling and the call:* handlers agree on who's in which call
// without a DB round trip on every signal. The Call document in Mongo remains the durable
// record (call history); this map only tracks "is a call live right now".
const activeCalls = new Map();

// roomId -> { hostId, participants: Set<userId> }. In-memory, per-process, same pattern
// as activeCalls above. The LiveRoom document in Mongo is the durable record (who was in
// the room, when it ended); this map only tracks "who's actually connected right now" so
// join/leave/signal relays don't need a DB round trip on every event.
const liveRooms = new Map();

function isUserOnline(userId) {
  return onlineSockets.has(String(userId));
}

function publicUser(user) {
  return { _id: user._id, id: user._id, name: user.name, username: user.username, avatarUrl: user.avatarUrl };
}

async function broadcastPresence(io, userId, isOnline, lastSeen) {
  const convos = await Conversation.find({ participants: userId }).select('_id');
  convos.forEach((c) => {
    io.to(`conversation:${c._id}`).emit('presence:update', { userId, isOnline, lastSeen });
  });
}

async function isParticipant(conversationId, userId) {
  const convo = await Conversation.findById(conversationId);
  return convo && convo.participants.some((p) => String(p) === String(userId));
}

function initSockets(io) {
  io.use(socketAuth);

  io.on('connection', async (socket) => {
    const userId = String(socket.user._id);
    socket.join(`user:${userId}`);

    if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
    onlineSockets.get(userId).add(socket.id);

    // This runs on every single connection (including reconnects after a network blip),
    // so an unhandled rejection here — e.g. a transient Mongo hiccup on findByIdAndUpdate —
    // would previously crash the whole process (Node 15+ terminates on unhandled promise
    // rejections by default), taking down Socket.IO *and* every REST route for every user
    // until someone manually restarted the server. Wrapping it means a failure here just
    // logs and leaves this one socket's presence update un-broadcast, instead of an outage.
    try {
      if (onlineSockets.get(userId).size === 1) {
        await User.findByIdAndUpdate(userId, { isOnline: true, lastSeen: new Date() });
        await broadcastPresence(io, userId, true, null);
      }
    } catch (err) {
      console.error('[socket connection] presence update failed', err);
    }

    // --- Join a conversation's room to receive its live events ---
    // conversationId arrives straight from the client with no prior validation. An invalid
    // ObjectId (stale id after a chat was deleted, a race on first render, a malformed
    // value) makes Conversation.findById throw a Mongoose CastError synchronously inside
    // this async handler — an unhandled rejection that used to crash the entire server.
    socket.on('conversation:join', async (conversationId) => {
      try {
        if (await isParticipant(conversationId, userId)) {
          socket.join(`conversation:${conversationId}`);
        }
      } catch (err) {
        console.error('[socket conversation:join]', err);
      }
    });

    socket.on('conversation:leave', (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
    });

    // --- Send a message ---
    socket.on('message:send', async (payload, ack) => {
      try {
        const { conversationId, type = 'text', text, mediaId, replyTo } = payload;

        // 'post' messages must only ever be created through POST /posts/:id/share-to,
        // which checks the sender can actually view that post first (see canView in
        // postController). This path has no such check, so without this guard anyone
        // could hand-craft { type: 'post', sharedPost: <any id> } here and produce a
        // shared-post card for content they were never authorized to see.
        if (type === 'post') {
          return ack?.({ success: false, message: 'Use the share option to send a post' });
        }

        // Suspended accounts can read but not send (mirrors requireNotSuspended on the
        // REST content routes — the socket path needs its own check since it bypasses
        // Express middleware entirely).
        const sender = await User.findById(userId);
        if (sender?.isSuspended) {
          const expired = sender.suspendedUntil && sender.suspendedUntil <= new Date();
          if (expired) {
            sender.isSuspended = false;
            sender.suspendedUntil = null;
            sender.suspensionReason = '';
            await sender.save();
          } else {
            return ack?.({ success: false, message: 'Your account is currently suspended.' });
          }
        }

        const convo = await Conversation.findById(conversationId);
        if (!convo || !convo.participants.some((p) => String(p) === userId)) {
          return ack?.({ success: false, message: 'Not a participant in this conversation' });
        }

        if (!convo.isGroup) {
          const otherId = convo.participants.find((p) => String(p) !== userId);
          const [me, other] = await Promise.all([User.findById(userId), User.findById(otherId)]);
          if (isBlockedPair(me, other)) {
            return ack?.({ success: false, message: 'You can’t message this user' });
          }
        }

        let mediaDoc;
        if (mediaId) {
          mediaDoc = await Media.findOne({ _id: mediaId, owner: userId });
          if (!mediaDoc) return ack?.({ success: false, message: 'Invalid media' });
        }

        const message = await Message.create({
          conversation: conversationId,
          sender: userId,
          type,
          text: text || '',
          media: mediaDoc?._id,
          replyTo: replyTo || null,
          deliveredTo: [userId],
          readBy: [userId],
        });

        const populated = await Message.findById(message._id)
          .populate('sender', 'name username avatarUrl')
          .populate('media')
          .populate({ path: 'replyTo', populate: { path: 'sender', select: 'name username' } });

        await Conversation.findByIdAndUpdate(conversationId, {
          lastMessage: {
            text: type === 'text' ? text : `Sent ${type === 'image' ? 'a photo' : type === 'video' ? 'a video' : 'a voice message'}`,
            sender: userId,
            sentAt: new Date(),
          },
          updatedAt: new Date(),
          $pull: { leftBy: userId },
        });

        const serialized = serializeMessage(populated);
        io.to(`conversation:${conversationId}`).emit('message:new', serialized);
        ack?.({ success: true, message: serialized });
      } catch (err) {
        console.error('[socket message:send]', err);
        ack?.({ success: false, message: 'Could not send message' });
      }
    });

    // --- Typing indicators ---
    socket.on('typing:start', ({ conversationId }) => {
      socket.to(`conversation:${conversationId}`).emit('typing:update', { conversationId, userId, isTyping: true });
    });
    socket.on('typing:stop', ({ conversationId }) => {
      socket.to(`conversation:${conversationId}`).emit('typing:update', { conversationId, userId, isTyping: false });
    });

    // --- Read receipts ---
    socket.on('message:read', async ({ conversationId }) => {
      try {
        if (!(await isParticipant(conversationId, userId))) return;
        await Message.updateMany(
          { conversation: conversationId, readBy: { $ne: userId } },
          { $addToSet: { readBy: userId, deliveredTo: userId } }
        );
        io.to(`conversation:${conversationId}`).emit('message:read:update', { conversationId, userId });
      } catch (err) {
        console.error('[socket message:read]', err);
      }
    });

    // --- Call signaling relay (offer/answer/ICE payloads pass through untouched) ---
    socket.on('call:signal', ({ toUserId, ...data }) => {
      io.to(`user:${toUserId}`).emit('call:signal', { fromUserId: userId, ...data });
    });

    // --- 1:1 voice/video calling (Phase 7) ---
    // One active call per user at a time, matching the client's single-call CallContext.
    socket.on('call:invite', async ({ toUserId, callType }, ack) => {
      try {
        if (!toUserId || !['voice', 'video'].includes(callType)) {
          return ack?.({ success: false, message: 'Invalid call request' });
        }
        if (String(toUserId) === userId) {
          return ack?.({ success: false, message: "You can't call yourself" });
        }

        const [me, callee] = await Promise.all([User.findById(userId), User.findById(toUserId)]);
        if (!callee || callee.isDeactivated) {
          return ack?.({ success: false, message: 'User not found' });
        }
        if (isBlockedPair(me, callee)) {
          return ack?.({ success: false, message: "You can't call this user" });
        }
        if (!isUserOnline(toUserId)) {
          return ack?.({ success: false, message: `${callee.name} is offline right now` });
        }

        const call = await Call.create({ caller: userId, callee: toUserId, type: callType, status: 'ringing' });
        activeCalls.set(String(call._id), { callerId: userId, calleeId: String(toUserId), status: 'ringing' });

        io.to(`user:${toUserId}`).emit('call:incoming', {
          callId: String(call._id),
          callType,
          from: publicUser(me),
        });

        ack?.({ success: true, callId: String(call._id) });
      } catch (err) {
        console.error('[socket call:invite]', err);
        ack?.({ success: false, message: 'Could not place call' });
      }
    });

    socket.on('call:accept', async ({ callId }) => {
      try {
        const entry = activeCalls.get(callId);
        if (!entry || entry.calleeId !== userId) return;

        entry.status = 'connected';
        await Call.findByIdAndUpdate(callId, { status: 'accepted', startedAt: new Date() });
        io.to(`user:${entry.callerId}`).emit('call:accepted', { callId });
      } catch (err) {
        console.error('[socket call:accept]', err);
      }
    });

    socket.on('call:reject', async ({ callId }) => {
      try {
        const entry = activeCalls.get(callId);
        if (!entry || (entry.callerId !== userId && entry.calleeId !== userId)) return;

        activeCalls.delete(callId);
        await Call.findByIdAndUpdate(callId, { status: 'rejected', endedAt: new Date() });
        const otherId = entry.callerId === userId ? entry.calleeId : entry.callerId;
        io.to(`user:${otherId}`).emit('call:rejected', { callId });
      } catch (err) {
        console.error('[socket call:reject]', err);
      }
    });

    socket.on('call:end', async ({ callId }) => {
      try {
        const entry = activeCalls.get(callId);
        if (!entry || (entry.callerId !== userId && entry.calleeId !== userId)) return;

        activeCalls.delete(callId);
        const call = await Call.findById(callId);
        if (!call) return;

        const endedAt = new Date();
        const durationSeconds = call.startedAt ? Math.max(0, Math.round((endedAt - call.startedAt) / 1000)) : 0;
        call.status = 'ended';
        call.endedAt = endedAt;
        call.durationSeconds = durationSeconds;
        await call.save();

        const otherId = entry.callerId === userId ? entry.calleeId : entry.callerId;
        io.to(`user:${otherId}`).emit('call:ended', { callId, durationSeconds });
      } catch (err) {
        console.error('[socket call:end]', err);
      }
    });

    // --- Live Rooms (section 36) ---
    // One-to-many broadcast, not a mesh: the host is the only peer publishing media, and
    // each viewer gets its own direct, receive-only connection to the host (see
    // LiveRoomView.jsx). This relay just passes offer/answer/ICE payloads through to a
    // specific peer — it doesn't care about topology — so a large audience would need an
    // SFU media server later without any change here; that's deliberately out of scope
    // for this first implementation (see LiveRoom.js).
    socket.on('liveroom:join', async ({ roomId }, ack) => {
      try {
        const room = await LiveRoom.findById(roomId);
        if (!room || room.status !== 'live') {
          return ack?.({ success: false, message: 'This room is no longer live' });
        }

        socket.join(`liveroom:${roomId}`);

        if (!liveRooms.has(roomId)) {
          liveRooms.set(roomId, { hostId: String(room.host), participants: new Set() });
        }
        const entry = liveRooms.get(roomId);
        const existingParticipants = [...entry.participants];
        entry.participants.add(userId);

        await LiveRoom.findByIdAndUpdate(roomId, {
          $addToSet: { participants: userId },
          $max: { peakViewers: entry.participants.size },
        });

        socket.to(`liveroom:${roomId}`).emit('liveroom:participant-joined', { userId, user: publicUser(socket.user) });
        ack?.({ success: true, existingParticipants, hostId: entry.hostId });
      } catch (err) {
        console.error('[socket liveroom:join]', err);
        ack?.({ success: false, message: 'Could not join the room' });
      }
    });

    socket.on('liveroom:leave', ({ roomId }) => {
      socket.leave(`liveroom:${roomId}`);
      const entry = liveRooms.get(roomId);
      if (!entry) return;
      entry.participants.delete(userId);
      io.to(`liveroom:${roomId}`).emit('liveroom:participant-left', { userId });
      if (entry.participants.size === 0) liveRooms.delete(roomId);
    });

    // Offer/answer/ICE payloads pass through untouched, scoped to a specific peer within the room
    socket.on('liveroom:signal', ({ roomId, toUserId, ...data }) => {
      io.to(`user:${toUserId}`).emit('liveroom:signal', { roomId, fromUserId: userId, ...data });
    });

    // Ephemeral live chat — not persisted, mirroring the "keep it simple for now" scope note
    socket.on('liveroom:comment', ({ roomId, text }) => {
      if (!text?.trim()) return;
      io.to(`liveroom:${roomId}`).emit('liveroom:comment', {
        roomId,
        user: publicUser(socket.user),
        text: text.trim().slice(0, 500),
        at: new Date(),
      });
    });

    socket.on('liveroom:reaction', ({ roomId, emoji }) => {
      if (!emoji) return;
      io.to(`liveroom:${roomId}`).emit('liveroom:reaction', { roomId, userId, emoji });
    });

    socket.on('liveroom:end', async ({ roomId }) => {
      try {
        const entry = liveRooms.get(roomId);
        if (!entry || entry.hostId !== userId) return;
        await LiveRoom.findByIdAndUpdate(roomId, { status: 'ended', endedAt: new Date() });
        io.to(`liveroom:${roomId}`).emit('liveroom:ended', { roomId });
        liveRooms.delete(roomId);
      } catch (err) {
        console.error('[socket liveroom:end]', err);
      }
    });

    socket.on('disconnect', async () => {
      const sockets = onlineSockets.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineSockets.delete(userId);
          const lastSeen = new Date();
          // Every disconnect (including a plain tab close) runs this — same unhandled-
          // rejection risk as the connection handler above, but far more frequent, so this
          // one is the likelier day-to-day trigger for the whole server going down.
          try {
            await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen });
            await broadcastPresence(io, userId, false, lastSeen);
          } catch (err) {
            console.error('[socket disconnect] presence update failed', err);
          }

          // Don't leave the other party ringing/talking to a dead peer forever —
          // resolve any call this (now fully offline) user was part of.
          for (const [callId, entry] of activeCalls.entries()) {
            if (entry.callerId !== userId && entry.calleeId !== userId) continue;
            activeCalls.delete(callId);
            const otherId = entry.callerId === userId ? entry.calleeId : entry.callerId;

            try {
              if (entry.status === 'ringing') {
                await Call.findByIdAndUpdate(callId, { status: 'missed', endedAt: new Date() });
                io.to(`user:${otherId}`).emit('call:missed', { callId });
                // Only meaningful when the disconnecting user was the callee (missed by them);
                // if the caller vanished mid-ring, there's no one left to notify about a "miss".
                if (entry.calleeId === userId) {
                  await notify(io, { recipient: entry.calleeId, actor: entry.callerId, type: 'missedCall' });
                }
              } else {
                const call = await Call.findById(callId);
                if (call) {
                  const endedAt = new Date();
                  call.status = 'ended';
                  call.endedAt = endedAt;
                  call.durationSeconds = call.startedAt ? Math.max(0, Math.round((endedAt - call.startedAt) / 1000)) : 0;
                  await call.save();
                }
                io.to(`user:${otherId}`).emit('call:ended', { callId });
              }
            } catch (err) {
              console.error('[socket disconnect call cleanup]', err);
            }
          }

          // Live rooms: if the disconnecting user was hosting, end the room outright
          // (there's no one broadcasting anymore); otherwise just drop them as a viewer.
          for (const [roomId, entry] of liveRooms.entries()) {
            if (!entry.participants.has(userId)) continue;
            entry.participants.delete(userId);

            if (entry.hostId === userId) {
              liveRooms.delete(roomId);
              try {
                await LiveRoom.findByIdAndUpdate(roomId, { status: 'ended', endedAt: new Date() });
              } catch (err) {
                console.error('[socket disconnect liveroom cleanup]', err);
              }
              io.to(`liveroom:${roomId}`).emit('liveroom:ended', { roomId });
            } else {
              io.to(`liveroom:${roomId}`).emit('liveroom:participant-left', { userId });
              if (entry.participants.size === 0) liveRooms.delete(roomId);
            }
          }
        }
      }
    });
  });
}

module.exports = { initSockets };
