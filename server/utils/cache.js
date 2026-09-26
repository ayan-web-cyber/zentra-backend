// A minimal in-memory TTL cache — deliberately not Redis-backed. It exists to stop the same
// expensive aggregation from re-running on every single request under load (e.g. Explore's
// trending queries), not to be a distributed cache. Each process has its own copy, which is
// fine for what this caches: content that's identical for every viewer (trending posts,
// hashtags), where a few instances briefly disagreeing for up to `ttlMs` is a non-issue.
// If this app scales to multiple instances and something here needs to be *consistent*
// across them, that's the point to move it into Redis instead.
const store = new Map();

async function getOrSet(key, ttlMs, computeFn) {
  const cached = store.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await computeFn();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function invalidate(key) {
  store.delete(key);
}

module.exports = { getOrSet, invalidate };
