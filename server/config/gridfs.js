const mongoose = require('mongoose');

let bucket = null;

// Returns a GridFSBucket backed by the same MongoDB Atlas connection/database
// used by Mongoose — no separate media service or account required.
function getBucket() {
  if (!bucket) {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Database connection not ready — cannot access GridFS bucket yet');
    }
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: process.env.GRIDFS_BUCKET || 'media',
    });
  }
  return bucket;
}

module.exports = { getBucket };
