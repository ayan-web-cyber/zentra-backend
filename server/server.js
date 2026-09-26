require('dotenv').config();

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const multer = require('multer');

const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const friendRoutes = require('./routes/friendRoutes');
const mediaRoutes = require('./routes/mediaRoutes');
const postRoutes = require('./routes/postRoutes');
const commentRoutes = require('./routes/commentRoutes');
const storyRoutes = require('./routes/storyRoutes');
const songRoutes = require('./routes/songRoutes');
const conversationRoutes = require('./routes/conversationRoutes');
const messageRoutes = require('./routes/messageRoutes');
const communityRoutes = require('./routes/communityRoutes');
const eventRoutes = require('./routes/eventRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const searchRoutes = require('./routes/searchRoutes');
const exploreRoutes = require('./routes/exploreRoutes');
const callRoutes = require('./routes/callRoutes');
const reportRoutes = require('./routes/reportRoutes');
const liveRoomRoutes = require('./routes/liveRoomRoutes');
const aiRoutes = require('./routes/aiRoutes');
const seedSongs = require('./utils/seedSongs');
const { initSockets } = require('./sockets');

const app = express();
const server = http.createServer(app);

// Behind any real deployment (Render, Railway, Heroku, Nginx, Cloudflare, a load balancer)
// the app sits at least one hop behind a proxy. Without this, req.ip resolves to the
// proxy's own address for every request from every user, so the rate limiter below would
// put ALL traffic into a single shared bucket — a handful of concurrent users would exhaust
// it almost immediately, and secure-cookie/HTTPS detection can misbehave too. Configurable
// via TRUST_PROXY for setups with more than one hop (a number) or a custom trust rule.
app.set('trust proxy', process.env.TRUST_PROXY || 1);

// Supports a comma-separated list (CLIENT_URLS) so a production domain, staging domain, and
// local dev can all be allowed at once; falls back to the single CLIENT_URL for simple setups.
const ALLOWED_ORIGINS = (process.env.CLIENT_URLS || process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // No Origin header (server-to-server calls, curl, some mobile webviews) — allow.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} is not allowed by CORS`));
  },
  credentials: true,
};

// --- Security & core middleware ---
app.use(helmet());
app.use(cors(corsOptions));
app.use(compression()); // gzip responses — meaningful bandwidth/latency win under real load
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(mongoSanitize());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// General API rate limit. This used to be 300 requests/15min for the entire app, which
// sounds generous until you count what a single active session actually does: initial load
// alone fires off /auth/me, the feed, stories, notifications, and more, and every keystroke
// in search/mention/tag-picker inputs fires its own (debounced) request. That ceiling was
// low enough to lock out a single real user within a few minutes of normal use, let alone
// several people sharing an IP (offices, mobile carriers, NAT). Raised substantially and
// made configurable; auth-specific endpoints keep their own much stricter limiter (see
// authRoutes.js) since brute-force protection on login/register is a different concern.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX) || 2000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests — please slow down and try again shortly.' },
  })
);

// --- Health check ---
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Zentra API is running', phase: 'Phase 11 — AI, Live Rooms & Recommendations' });
});

// --- Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/stories', storyRoutes);
app.use('/api/songs', songRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/communities', communityRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/explore', exploreRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/live-rooms', liveRoomRoutes);
app.use('/api/ai', aiRoutes);

// --- 404 handler ---
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// --- Central error handler (never leaks stack traces in production) ---
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);

  // Multer errors (voice/image/video uploads) arrive here via upload.single()'s
  // next(err) — surface an actionable, specific message instead of a generic 500.
  if (err instanceof multer.MulterError) {
    const maxMb = Number(process.env.MAX_UPLOAD_SIZE_MB || 25);
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That file is too large. The limit is ${maxMb}MB.`
        : 'Could not upload that file. Please try again.';
    return res.status(400).json({ success: false, message });
  }
  if (err.message?.startsWith('Unsupported file type')) {
    return res.status(400).json({ success: false, message: err.message });
  }

  const status = err.statusCode || 500;
  res.status(status).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
  });
});

// --- Socket.IO ---
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, credentials: true },
});

// A single Node process can only handle so many concurrent WebSocket connections and CPU-
// bound work (this app is otherwise stateless/horizontally-scalable via the JWT cookie).
// Socket.IO's in-memory default only broadcasts to sockets connected to THIS process,
// though — running more than one instance behind a load balancer would silently break
// delivery to users connected to a different instance than the sender. Setting REDIS_URL
// enables the Redis adapter so all instances share broadcasts correctly; leaving it unset
// keeps today's single-instance behavior with no extra moving parts to run.
async function setupSocketAdapter() {
  if (!process.env.REDIS_URL) return;
  try {
    const { createClient } = require('redis');
    const { createAdapter } = require('@socket.io/redis-adapter');
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log('[Socket.IO] Redis adapter connected — ready for multi-instance scaling');
  } catch (err) {
    console.error(
      '[Socket.IO] REDIS_URL is set but the adapter could not connect — falling back to ' +
        'single-instance mode. Run `npm install` in server/ to ensure the optional redis ' +
        'and @socket.io/redis-adapter packages are present. Error:',
      err.message
    );
  }
}
setupSocketAdapter();

// Lets REST controllers (likes, comments, follows, friend requests, ...) push real-time
// notifications through the same socket server without importing sockets/index.js directly.
app.set('io', io);

initSockets(io);

// --- Start server ---
const PORT = process.env.PORT || 5000;

connectDB().then(async () => {
  await seedSongs().catch((err) => console.error('[seedSongs] failed (non-fatal):', err.message));
  server.listen(PORT, () => {
    console.log(`[Zentra API] Listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
});

// Under real traffic, deploys/restarts/autoscaling send SIGTERM (or SIGINT locally via
// Ctrl+C) to running processes. Without handling it, in-flight HTTP requests and open
// sockets get dropped mid-response instead of finishing cleanly, and the Mongo connection
// pool is torn down abruptly rather than closed. This lets the current work finish first.
function gracefulShutdown(signal) {
  console.log(`[Zentra API] ${signal} received, shutting down gracefully…`);
  server.close(async () => {
    console.log('[Zentra API] HTTP server closed');
    try {
      await mongoose.connection.close(false);
      console.log('[Zentra API] MongoDB connection closed');
    } catch (err) {
      console.error('[Zentra API] Error closing MongoDB connection:', err.message);
    }
    process.exit(0);
  });

  // Safety net: if something is still hanging after 10s, exit anyway rather than leaving a
  // zombie process behind for an orchestrator to eventually SIGKILL.
  setTimeout(() => {
    console.error('[Zentra API] Forced shutdown after 10s timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Safety net, not a substitute for fixing the source: any async route or socket handler
// that throws without a try/catch produces an unhandled promise rejection, and Node 15+
// terminates the entire process on those by default — silently taking down every user's
// REST calls and Socket.IO connection at once, with no stack trace unless something logs
// it first. This won't repair whatever broke, but it stops one missed try/catch anywhere
// in the app from being a full outage, and makes the actual error visible so it can be
// fixed at the source (see sockets/index.js for the handlers that previously lacked this).
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection] This indicates a missing try/catch somewhere — fix the source:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

module.exports = { app, server, io };
