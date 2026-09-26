const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Verifies the JWT (from httpOnly cookie or Authorization header) and attaches req.user
const protect = async (req, res, next) => {
  try {
    let token = req.cookies?.[process.env.JWT_COOKIE_NAME || 'cs_token'];

    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user || user.isDeactivated) {
      return res.status(401).json({ success: false, message: 'User no longer exists' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session' });
  }
};

// Optional auth: attaches req.user if a valid token is present, otherwise continues anonymously
const optionalAuth = async (req, res, next) => {
  try {
    let token = req.cookies?.[process.env.JWT_COOKIE_NAME || 'cs_token'];
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (user && !user.isDeactivated) req.user = user;
    next();
  } catch {
    next();
  }
};

module.exports = { protect, optionalAuth };
