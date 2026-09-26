const jwt = require('jsonwebtoken');
const User = require('../models/User');

const COOKIE_NAME = process.env.JWT_COOKIE_NAME || 'cs_token';

// Pulls the JWT out of the raw Cookie header on the socket handshake (falls back to
// handshake.auth.token for non-browser/native clients that can't send cookies).
function extractToken(socket) {
  const authToken = socket.handshake.auth?.token;
  if (authToken) return authToken;

  const cookieHeader = socket.handshake.headers?.cookie;
  if (!cookieHeader) return null;

  const match = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return match ? decodeURIComponent(match.split('=')[1]) : null;
}

module.exports = async function socketAuth(socket, next) {
  try {
    const token = extractToken(socket);
    if (!token) return next(new Error('Authentication required'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || user.isDeactivated) return next(new Error('Authentication required'));

    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Authentication required'));
  }
};
