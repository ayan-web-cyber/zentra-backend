const Song = require('../models/Song');

function serializeSong(song) {
  return {
    id: song._id,
    title: song.title,
    artist: song.artist,
    audioUrl: song.audioUrl,
    coverColor: song.coverColor,
    duration: song.duration,
    category: song.category,
  };
}

// GET /api/songs/trending — top tracks by usage, for the "Trending" tab of the picker
exports.getTrendingSongs = async (req, res) => {
  try {
    const songs = await Song.find().sort({ usageCount: -1, createdAt: -1 }).limit(30);
    return res.json({ success: true, songs: songs.map(serializeSong) });
  } catch (err) {
    console.error('[getTrendingSongs]', err);
    return res.status(500).json({ success: false, message: 'Could not load trending songs' });
  }
};

// GET /api/songs?q=... — search by title/artist
exports.searchSongs = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let songs;
    if (q) {
      songs = await Song.find({ $text: { $search: q } }, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(30);
    } else {
      songs = await Song.find().sort({ usageCount: -1, createdAt: -1 }).limit(30);
    }
    return res.json({ success: true, songs: songs.map(serializeSong) });
  } catch (err) {
    console.error('[searchSongs]', err);
    return res.status(500).json({ success: false, message: 'Search failed' });
  }
};

exports.serializeSong = serializeSong;
