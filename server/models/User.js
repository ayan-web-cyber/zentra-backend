const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 50 },
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 30,
      match: /^[a-z0-9_.]+$/,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: /^\S+@\S+\.\S+$/,
    },
    password: { type: String, required: true, minlength: 8, select: false },
    avatarUrl: { type: String, default: '' },
    coverUrl: { type: String, default: '' },
    bio: { type: String, default: '', maxlength: 160 },

    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    isPrivate: { type: Boolean, default: false },
    privacy: {
      posts: { type: String, enum: ['everyone', 'followers', 'friends', 'onlyMe'], default: 'everyone' },
      messages: { type: String, enum: ['everyone', 'followers', 'friends', 'nobody'], default: 'everyone' },
      calls: { type: String, enum: ['everyone', 'friends', 'nobody'], default: 'everyone' },
      stories: { type: String, enum: ['everyone', 'friends', 'closeFriends', 'nobody'], default: 'everyone' },
    },

    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Muting is one-directional and silent: the muted person is never told, keeps full
    // access, and can still message/follow — their content just stops appearing in the
    // muter's feed and stories. That's what separates it from blocking.
    mutedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Backs the 'closeFriends' story-privacy option, which had an enum value but no
    // underlying list to check against until now.
    closeFriends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    lastSeen: { type: Date, default: Date.now },
    isOnline: { type: Boolean, default: false },

    themePreference: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },

    // Moderation (section 40). 'moderator' can action reports; 'admin' additionally can
    // change other users' roles. Deliberately defaults to a plain user — promoting the
    // first moderator is a deliberate operational step, not something the app hands out.
    role: { type: String, enum: ['user', 'moderator', 'admin'], default: 'user', index: true },

    // Set by a moderator actioning a report. A suspended account can still log in (so the
    // person can see they're suspended rather than being silently broken) but is blocked
    // from creating content — see requireNotSuspended.
    isSuspended: { type: Boolean, default: false },
    suspendedUntil: { type: Date, default: null },
    suspensionReason: { type: String, default: '' },

    isDeactivated: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userSchema.index({ username: 'text', name: 'text' });

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toSafeObject = function toSafeObject() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
