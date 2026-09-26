const User = require('../models/User');
const Post = require('../models/Post');
const Community = require('../models/Community');
const Event = require('../models/Event');
const { serializePost } = require('./postController');

function serializeCommunity(c) {
  return {
    _id: c._id,
    name: c.name,
    slug: c.slug,
    icon: c.icon,
    description: c.description,
    category: c.category,
    privacy: c.privacy,
    cover: c.cover ? { id: c.cover._id, url: `/api/media/${c.cover.gridfsId}` } : null,
    avatar: c.avatar ? { id: c.avatar._id, url: `/api/media/${c.avatar.gridfsId}` } : null,
    memberCount: c.members?.length || 0,
  };
}

function serializeEvent(e) {
  return {
    _id: e._id,
    name: e.name,
    description: e.description,
    startAt: e.startAt,
    endAt: e.endAt,
    location: e.location,
    isOnline: e.isOnline,
    cover: e.cover ? { id: e.cover._id, url: `/api/media/${e.cover.gridfsId}` } : null,
    organizer: e.organizer,
    goingCount: e.going?.length || 0,
    interestedCount: e.interested?.length || 0,
  };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function visibilityFilter(viewerId) {
  // Same rule the feed uses: everyone posts are visible to anyone; followers/friends/onlyMe
  // posts only show for the author themself here (a full graph-aware check happens on the
  // feed/profile endpoints — search results intentionally stay conservative).
  return {
    $or: [{ visibility: 'everyone' }, { author: viewerId }],
  };
}

// GET /api/search?q=&type=all|users|posts|hashtags|communities|events&limit=
exports.search = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const type = req.query.type || 'all';
    const limit = Math.min(Number(req.query.limit) || 8, 20);

    if (!q) {
      return res.json({ success: true, query: q, users: [], posts: [], hashtags: [], communities: [], events: [] });
    }

    const safe = escapeRegex(q);
    const regex = new RegExp(safe, 'i');
    const viewerId = req.user._id;

    const results = { query: q, users: [], posts: [], hashtags: [], communities: [], events: [] };

    const isHashtagQuery = q.startsWith('#');
    const hashtagTerm = isHashtagQuery ? q.slice(1) : q;

    const tasks = [];

    if (type === 'all' || type === 'users') {
      tasks.push(
        User.find({
          isDeactivated: { $ne: true },
          _id: { $nin: req.user.blockedUsers || [] },
          $or: [{ username: regex }, { name: regex }],
        })
          .select('name username avatarUrl bio followers')
          .limit(limit)
          .then((users) => {
            results.users = users.map((u) => ({
              _id: u._id,
              name: u.name,
              username: u.username,
              avatarUrl: u.avatarUrl,
              bio: u.bio,
              followerCount: u.followers.length,
            }));
          })
      );
    }

    if (type === 'all' || type === 'posts' || type === 'hashtags') {
      tasks.push(
        Post.find({
          ...visibilityFilter(viewerId),
          caption: isHashtagQuery ? new RegExp(`#${escapeRegex(hashtagTerm)}`, 'i') : regex,
        })
          .sort({ createdAt: -1 })
          .limit(limit)
          .populate('author', 'name username avatarUrl')
          .then(async (posts) => {
            results.posts = await Promise.all(posts.map((p) => serializePost(p, viewerId)));
          })
      );
    }

    if (type === 'all' || type === 'hashtags') {
      tasks.push(
        Post.aggregate([
          { $match: { caption: { $regex: '#\\w+', $options: 'i' } } },
          { $project: { tags: { $regexFindAll: { input: '$caption', regex: /#\w+/ } } } },
          { $unwind: '$tags' },
          { $project: { tag: { $toLower: '$tags.match' } } },
          { $match: { tag: new RegExp(`^#${escapeRegex(hashtagTerm.toLowerCase())}`) } },
          { $group: { _id: '$tag', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: limit },
        ]).then((rows) => {
          results.hashtags = rows.map((r) => ({ tag: r._id, count: r.count }));
        })
      );
    }

    if (type === 'all' || type === 'communities') {
      tasks.push(
        Community.find({ $or: [{ name: regex }, { description: regex }] })
          .select('name slug icon description category privacy members cover avatar')
          .populate('cover')
          .populate('avatar')
          .limit(limit)
          .then((communities) => {
            results.communities = communities.map(serializeCommunity);
          })
      );
    }

    if (type === 'all' || type === 'events') {
      tasks.push(
        Event.find({ $or: [{ name: regex }, { description: regex }, { location: regex }] })
          .select('name description startAt endAt location isOnline cover organizer')
          .sort({ startAt: 1 })
          .limit(limit)
          .populate('cover')
          .populate('organizer', 'name username avatarUrl')
          .then((events) => {
            results.events = events.map(serializeEvent);
          })
      );
    }

    await Promise.all(tasks);

    return res.json({ success: true, ...results });
  } catch (err) {
    console.error('[search]', err);
    return res.status(500).json({ success: false, message: 'Search failed' });
  }
};
