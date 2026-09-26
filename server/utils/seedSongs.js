const Song = require('../models/Song');

// Demo "trending sounds" for the Story music picker (section 52: seed/demo data,
// easy to remove later — just drop the songs collection).
//
// These point at freely-licensed sample audio so the feature is playable out of
// the box. Swap DEMO_SONGS (or the whole seeder) for a real licensed music-catalog
// integration before shipping to production — the Song model and /api/songs
// endpoints don't need to change, only where the rows come from.
const DEMO_SONGS = [
  { title: 'Neon Skyline', artist: 'Zentra Sounds', category: 'trending', usageCount: 980 },
  { title: 'Midnight Drive', artist: 'Aurora Beats', category: 'trending', usageCount: 860 },
  { title: 'Golden Hour', artist: 'Zentra Sounds', category: 'chill', usageCount: 740 },
  { title: 'Electric Pulse', artist: 'Nova Wave', category: 'trending', usageCount: 705 },
  { title: 'Paper Planes', artist: 'Zentra Sounds', category: 'pop', usageCount: 640 },
  { title: 'City Lights', artist: 'Aurora Beats', category: 'trending', usageCount: 590 },
  { title: 'Slow Motion', artist: 'Nova Wave', category: 'chill', usageCount: 510 },
  { title: 'Bassline Groove', artist: 'Zentra Sounds', category: 'hiphop', usageCount: 470 },
  { title: 'Daydream', artist: 'Aurora Beats', category: 'mood', usageCount: 320 },
  { title: 'Weekend Vibes', artist: 'Nova Wave', category: 'pop', usageCount: 280 },
];

// SoundHelix publishes freely licensed sample tracks specifically for use as
// demo/placeholder audio in projects like this one; cycle through them so every
// demo song is actually playable.
const SAMPLE_URLS = [
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3',
];

const COLORS = ['#7C3AED', '#06B6D4', '#F43F5E', '#22D3EE', '#A855F7', '#F59E0B'];

async function seedSongs() {
  const count = await Song.countDocuments();
  if (count > 0) return;

  const docs = DEMO_SONGS.map((song, i) => ({
    ...song,
    audioUrl: SAMPLE_URLS[i % SAMPLE_URLS.length],
    coverColor: COLORS[i % COLORS.length],
    duration: 30,
  }));

  await Song.insertMany(docs);
  console.log(`[seedSongs] Seeded ${docs.length} demo songs for the story music picker`);
}

module.exports = seedSongs;
