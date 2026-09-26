const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // Mongoose's default pool (100) is plenty for most deployments, but under real
      // concurrent traffic it's worth being able to tune without a code change — e.g. a
      // small MongoDB Atlas tier has its own connection ceiling well below 100, and
      // running several server instances/replicas means each one needs its own headroom.
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 50,
      minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 5,
      // Fail fast on a bad connection string/network issue instead of hanging on startup.
      serverSelectionTimeoutMS: 10000,
    });
    console.log(`[MongoDB] Connected: ${conn.connection.host} (pool: ${conn.connection.config?.maxPoolSize ?? 'default'})`);

    await syncAllIndexes();
  } catch (err) {
    console.error(`[MongoDB] Connection error: ${err.message}`);
    process.exit(1);
  }
};

// Mongoose's autoIndex only CREATES indexes that are missing — it does not retroactively
// alter or replace an index that already exists in the database under the same key pattern
// but with different options (e.g. adding a partialFilterExpression to an existing unique
// index). If a model's index definition changes after the app has already been run once
// against a database, the OLD index just keeps enforcing its OLD rules forever, silently,
// with no error at startup. That's exactly what caused friend requests to become permanently
// unsendable after an unfriend: the unique index on FriendRequest used to apply to every
// status, later scoped to pending-only, but a database that had already created the old
// index never picked up the change. Model.syncIndexes() reconciles the two — drops indexes
// that no longer match the schema and creates any that are missing — so this class of bug
// can't quietly reappear the next time an index definition changes on an existing database.
async function syncAllIndexes() {
  const results = await Promise.allSettled(
    mongoose.modelNames().map((name) => mongoose.model(name).syncIndexes())
  );
  results.forEach((result, i) => {
    const modelName = mongoose.modelNames()[i];
    if (result.status === 'rejected') {
      console.error(`[MongoDB] Index sync failed for ${modelName}:`, result.reason?.message);
    }
  });
  console.log(`[MongoDB] Indexes synced for ${results.filter((r) => r.status === 'fulfilled').length}/${results.length} models`);
}

module.exports = connectDB;
