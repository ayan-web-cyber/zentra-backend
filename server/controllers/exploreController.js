const User = require('../models/User');
const Post = require('../models/Post');
const Community = require('../models/Community');
const { serializePost } = require('./postController');
const { getOrSet } = require('../utils/cache');

const TRENDING_CACHE_TTL_MS = 60 * 1000; // trending content doesn't need to be second-fresh

// "People You May Know" — heuristic, not ML: rank candidates by how many people the
// viewer already follows also follow them (mutual connections), breaking ties by
// follower count. Falls back to recent signups when the viewer doesn't follow anyone yet
// (mutuals are meaningless with zero starting points).
async function getPeopleYouMayKnow(viewerId, viewerUser, limit = 10) {
  const excluded = [viewerId, ...(viewerUser.following || []), ...(viewerUser.blockedUsers || [])];

  if ((viewerUser.following || []).length > 0) {
    const ranked = await User.aggregate([
      { $match: { _id: { $in: viewerUser.following } } },
      { $unwind: '$following' },
      { $match: { following: { $nin: excluded } } },
      { $group: { _id: '$following', mutualCount: { $sum: 1 } } },
      { $sort: { mutualCount: -1 } },
      { $limit: limit * 2 }, // overfetch — isDeactivated candidates get filtered below
    ]);

    if (ranked.length) {
      const ids = ranked.map((r) => r._id);
      const docs = await User.find({ _id: { $in: ids }, isDeactivated: { $ne: true } }).select(
        'name username avatarUrl bio followers'
      );
      const mutualById = new Map(ranked.map((r) => [String(r._id), r.mutualCount]));
      return docs
        .sort((a, b) => (mutualById.get(String(b._id)) || 0) - (mutualById.get(String(a._id)) || 0))
        .slice(0, limit)
        .map((u) => {
          u._mutualCount = mutualById.get(String(u._id)) || 0;
          return u;
        });
    }
  }

  return User.find({ _id: { $nin: excluded }, isDeactivated: { $ne: true } })
    .select('name username avatarUrl bio followers')
    .sort({ createdAt: -1 })
    .limit(limit);
}

// "Recommended for you" posts — heuristic affinity based on the hashtags the viewer has
// recently engaged with (liked). Falls back to general trending when there's no like
// history yet to learn from.
async function getRecommendedPosts(viewerId, viewerUser, since, rankedPosts, limit = 18) {
  const likedTags = await Post.aggregate([
    { $match: { likes: viewerId, caption: { $regex: '#\\w+', $options: 'i' } } },
    { $sort: { updatedAt: -1 } },
    { $limit: 50 },
    { $project: { tags: { $regexFindAll: { input: '$caption', regex: /#\w+/ } } } },
    { $unwind: '$tags' },
    { $project: { tag: { $toLower: '$tags.match' } } },
    { $group: { _id: '$tag', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 8 },
  ]);

  if (!likedTags.length) return [];

  const tagPattern = likedTags.map((t) => t._id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return rankedPosts(
    {
      visibility: 'everyone',
      author: { $ne: viewerId },
      likes: { $ne: viewerId }, // don't recommend what they already liked
      caption: { $regex: tagPattern, $options: 'i' },
      createdAt: { $gte: since },
    },
    limit
  );
}

// GET /api/explore
// One combined payload for the Explore page: trending posts (by engagement, last 7 days),
// trending hashtags, popular reels, personalized recommendations, suggested people, and
// suggested communities.
exports.getExplore = async (req, res) => {
  try {
    const viewerId = req.user._id;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Aggregates return plain objects (no Mongoose document methods), but serializePost()
    // needs real documents (it calls .toObject()). So the aggregation only ranks IDs; a
    // second query re-hydrates full, populated documents in that ranked order.
    async function rankedPosts(match, limit) {
      const ranked = await Post.aggregate([
        { $match: match },
        {
          $addFields: {
            score: { $add: [{ $size: '$likes' }, { $multiply: ['$commentCount', 2] }, '$shareCount'] },
          },
        },
        { $sort: { score: -1, createdAt: -1 } },
        { $limit: limit },
        { $project: { _id: 1 } },
      ]);
      const ids = ranked.map((r) => r._id);
      const docs = await Post.find({ _id: { $in: ids } })
        .populate('author', 'name username avatarUrl followers')
        .populate('media')
        .populate('taggedUsers', 'name username avatarUrl')
        .populate('community', 'name slug icon');
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      return ids.map((id) => byId.get(String(id))).filter(Boolean);
    }

    const [trendingPosts, trendingReels, trendingHashtags, suggestedPeople, suggestedCommunities, recommendedPosts] =
      await Promise.all([
        getOrSet('explore:trendingPosts', TRENDING_CACHE_TTL_MS, () =>
          rankedPosts({ visibility: 'everyone', createdAt: { $gte: since }, media: { $ne: [] } }, 24)
        ),

        getOrSet('explore:trendingReels', TRENDING_CACHE_TTL_MS, () =>
          rankedPosts({ visibility: 'everyone', isReel: true, createdAt: { $gte: since } }, 12)
        ),

        getOrSet('explore:trendingHashtags', TRENDING_CACHE_TTL_MS, () =>
          Post.aggregate([
            { $match: { caption: { $regex: '#\\w+', $options: 'i' }, createdAt: { $gte: since } } },
            { $project: { tags: { $regexFindAll: { input: '$caption', regex: /#\w+/ } } } },
            { $unwind: '$tags' },
            { $project: { tag: { $toLower: '$tags.match' } } },
            { $group: { _id: '$tag', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 },
          ])
        ),

        getPeopleYouMayKnow(viewerId, req.user),

        Community.find({ privacy: 'public', members: { $ne: viewerId } })
          .select('name slug icon description category members cover avatar')
          .populate('cover')
          .populate('avatar')
          .sort({ createdAt: -1 })
          .limit(10),

        getRecommendedPosts(viewerId, req.user, since, rankedPosts),
      ]);

    return res.json({
      success: true,
      trendingPosts: await Promise.all(trendingPosts.map((p) => serializePost(p, viewerId))),
      trendingReels: await Promise.all(trendingReels.map((p) => serializePost(p, viewerId))),
      trendingHashtags: trendingHashtags.map((h) => ({ tag: h._id, count: h.count })),
      recommendedPosts: await Promise.all(recommendedPosts.map((p) => serializePost(p, viewerId))),
      suggestedPeople: suggestedPeople.map((u) => ({
        _id: u._id,
        name: u.name,
        username: u.username,
        avatarUrl: u.avatarUrl,
        bio: u.bio,
        followerCount: u.followers.length,
        mutualCount: u._mutualCount || 0,
      })),
      suggestedCommunities: suggestedCommunities.map((c) => ({
        _id: c._id,
        name: c.name,
        slug: c.slug,
        icon: c.icon,
        description: c.description,
        category: c.category,
        cover: c.cover ? { id: c.cover._id, url: `/api/media/${c.cover.gridfsId}` } : null,
        avatar: c.avatar ? { id: c.avatar._id, url: `/api/media/${c.avatar.gridfsId}` } : null,
        memberCount: c.members.length,
      })),
    });
  } catch (err) {
    console.error('[getExplore]', err);
    return res.status(500).json({ success: false, message: 'Could not load explore feed' });
  }
};
