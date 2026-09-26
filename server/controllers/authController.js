const jwt = require('jsonwebtoken');
const User = require('../models/User');

const COOKIE_NAME = process.env.JWT_COOKIE_NAME || 'cs_token';

const signToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

const sendTokenCookie = (res, token) => {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

// POST /api/auth/register
exports.register = async (req, res) => {
  try {
    const { name, username, email, password, avatarUrl } = req.body;

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: existing.email === email ? 'Email already in use' : 'Username already taken',
      });
    }

    const user = await User.create({ name, username, email, password, avatarUrl });
    const token = signToken(user._id);
    sendTokenCookie(res, token);

    return res.status(201).json({ success: true, user: user.toSafeObject(), token });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('[register]', err);
    return res.status(500).json({ success: false, message: 'Registration failed' });
  }
};

// POST /api/auth/login
exports.login = async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;
    if (!emailOrUsername || !password) {
      return res.status(400).json({ success: false, message: 'Email/username and password are required' });
    }

    const user = await User.findOne({
      $or: [{ email: emailOrUsername.toLowerCase() }, { username: emailOrUsername.toLowerCase() }],
    }).select('+password');

    if (!user || user.isDeactivated) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    user.isOnline = true;
    user.lastSeen = new Date();
    await user.save();

    const token = signToken(user._id);
    sendTokenCookie(res, token);

    return res.json({ success: true, user: user.toSafeObject(), token });
  } catch (err) {
    console.error('[login]', err);
    return res.status(500).json({ success: false, message: 'Login failed' });
  }
};

// POST /api/auth/logout
exports.logout = async (req, res) => {
  try {
    if (req.user) {
      req.user.isOnline = false;
      req.user.lastSeen = new Date();
      await req.user.save();
    }
    res.clearCookie(COOKIE_NAME);
    return res.json({ success: true, message: 'Logged out' });
  } catch (err) {
    console.error('[logout]', err);
    return res.status(500).json({ success: false, message: 'Logout failed' });
  }
};

// GET /api/auth/me
exports.me = async (req, res) => {
  return res.json({ success: true, user: req.user.toSafeObject() });
};
