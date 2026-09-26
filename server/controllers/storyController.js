const Story = require('../models/Story');
const Media = require('../models/Media');
const User = require('../models/User');
const Song = require('../models/Song');

function serializeStory(story, viewerId) {
  const obj = story.toObject();
  return {
    _id: obj._id,
    type: obj.type,
    mediaUrl: obj.media?.gridfsId ? `/api/media/${obj.media.gridfsId}` : null,
    mediaMimeType: obj.media?.mimeType,
    textContent: obj.textContent,
    backgroundColor: obj.backgroundColor,
    caption: obj.caption || '',
    textOverlay: obj.textOverlay?.text ? obj.textOverlay : null,
    song: obj.song?.audioUrl
      ? {
          title: obj.song.title,
          artist: obj.song.artist,
          audioUrl: obj.song.audioUrl,
          startTime: obj.song.startTime || 0,
          keepOriginalAudio: !!obj.song.keepOriginalAudio,
        }
      : null,
    createdAt: obj.createdAt,
    expiresAt: obj.expiresAt,
    viewerCount: obj.viewers.length,
    isViewedByMe: viewerId ? obj.viewers.some((v) => String(v.user) === String(viewerId)) : false,
    isOwn: viewerId ? String(obj.author?._id || obj.author) === String(viewerId) : false,
  };
}

// POST /api/stories  { type, mediaId?, textContent?, backgroundColor? }
exports.createStory = async (req, res) => {
  try {
    const { type, mediaId, textContent, backgroundColor, caption, textOverlay, songId, songStartTime, keepOriginalAudio } =
      req.body;
    if (!['photo', 'video', 'text', 'voice'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid story type' });
    }

    let media;
    if (type !== 'text') {
      if (!mediaId) return res.status(400).json({ success: false, message: 'Media is required for this story type' });
      media = await Media.findOne({ _id: mediaId, owner: req.user._id });
      if (!media) return res.status(400).json({ success: false, message: 'Invalid media' });
    } else if (!textContent?.trim()) {
      return res.status(400).json({ success: false, message: 'Text stories need some text' });
    }

    // Optional text overlay drawn on top of a photo/video story.
    let storyTextOverlay;
    if (textOverlay?.text?.trim()) {
      storyTextOverlay = {
        text: String(textOverlay.text).slice(0, 120),
        color: textOverlay.color || '#FFFFFF',
        position: ['top', 'center', 'bottom'].includes(textOverlay.position) ? textOverlay.position : 'center',
      };
    }

    // Optional attached song — snapshot the catalog row so the story keeps
    // working even if the song is later removed from the library.
    let storySong;
    if (songId) {
      const song = await Song.findById(songId);
      if (!song) return res.status(400).json({ success: false, message: 'Song not found' });
      storySong = {
        song: song._id,
        title: song.title,
        artist: song.artist,
        audioUrl: song.audioUrl,
        startTime: Math.max(0, Number(songStartTime) || 0),
        // "Keep original audio" only makes sense for videos — anything else has no
        // clip audio to preserve, so force it off regardless of what was sent.
        keepOriginalAudio: type === 'video' ? !!keepOriginalAudio : false,
      };
      song.usageCount += 1;
      await song.save();
    }

    const story = await Story.create({
      author: req.user._id,
      type,
      media: media?._id,
      textContent,
      backgroundColor,
      caption: caption?.trim() ? caption.trim().slice(0, 300) : undefined,
      textOverlay: storyTextOverlay,
      song: storySong,
    });

    const populated = await Story.findById(story._id).populate('media');
    return res.status(201).json({ success: true, story: serializeStory(populated, req.user._id) });
  } catch (err) {
    console.error('[createStory]', err);
    return res.status(500).json({ success: false, message: 'Could not create story' });
  }
};

// GET /api/stories/feed — active stories from people I follow (+ my own), grouped by author
exports.getStoriesFeed = async (req, res) => {
  try {
    const authorIds = [...req.user.following, req.user._id];
    const stories = await Story.find({ author: { $in: authorIds }, expiresAt: { $gt: new Date() } })
      .sort('createdAt')
      .populate('author', 'name username avatarUrl')
      .populate('media');

    const grouped = new Map();
    for (const story of stories) {
      const key = String(story.author._id);
      if (!grouped.has(key)) {
        grouped.set(key, {
          author: { _id: story.author._id, name: story.author.name, username: story.author.username, avatarUrl: story.author.avatarUrl },
          stories: [],
          allViewed: true,
        });
      }
      const entry = grouped.get(key);
      const serialized = serializeStory(story, req.user._id);
      entry.stories.push(serialized);
      if (!serialized.isViewedByMe) entry.allViewed = false;
    }

    return res.json({ success: true, groups: Array.from(grouped.values()) });
  } catch (err) {
    console.error('[getStoriesFeed]', err);
    return res.status(500).json({ success: false, message: 'Could not load stories' });
  }
};

// POST /api/stories/:storyId/view
exports.viewStory = async (req, res) => {
  try {
    const story = await Story.findById(req.params.storyId);
    if (!story) return res.status(404).json({ success: false, message: 'Story not found (it may have expired)' });

    const alreadyViewed = story.viewers.some((v) => String(v.user) === String(req.user._id));
    if (!alreadyViewed) {
      story.viewers.push({ user: req.user._id });
      await story.save();
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[viewStory]', err);
    return res.status(500).json({ success: false, message: 'Could not record view' });
  }
};

// GET /api/stories/:storyId/viewers — author-only
exports.getStoryViewers = async (req, res) => {
  try {
    const story = await Story.findById(req.params.storyId).populate('viewers.user', 'name username avatarUrl');
    if (!story) return res.status(404).json({ success: false, message: 'Story not found' });
    if (String(story.author) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    return res.json({
      success: true,
      viewers: story.viewers.map((v) => ({ user: v.user, viewedAt: v.viewedAt })),
    });
  } catch (err) {
    console.error('[getStoryViewers]', err);
    return res.status(500).json({ success: false, message: 'Could not load viewers' });
  }
};

// DELETE /api/stories/:storyId
exports.deleteStory = async (req, res) => {
  try {
    const story = await Story.findById(req.params.storyId);
    if (!story) return res.status(404).json({ success: false, message: 'Story not found' });
    if (String(story.author) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    await story.deleteOne();
    return res.json({ success: true, message: 'Story deleted' });
  } catch (err) {
    console.error('[deleteStory]', err);
    return res.status(500).json({ success: false, message: 'Could not delete story' });
  }
};
