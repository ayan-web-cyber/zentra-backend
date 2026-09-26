const Comment = require('../models/Comment');
const Post = require('../models/Post');
const notify = require('../utils/notify');

function serializeComment(comment) {
  const obj = comment.toObject();
  return { ...obj, likeCount: obj.likes.length, likes: undefined };
}

// GET /api/posts/:postId/comments — top-level comments with their replies nested one level deep
exports.listComments = async (req, res) => {
  try {
    const comments = await Comment.find({ post: req.params.postId, parentComment: null, isDeleted: false })
      .populate('author', 'name username avatarUrl')
      .sort('createdAt');

    const replies = await Comment.find({
      post: req.params.postId,
      parentComment: { $in: comments.map((c) => c._id) },
      isDeleted: false,
    })
      .populate('author', 'name username avatarUrl')
      .sort('createdAt');

    const byParent = {};
    replies.forEach((r) => {
      const key = String(r.parentComment);
      byParent[key] = byParent[key] || [];
      byParent[key].push(serializeComment(r));
    });

    return res.json({
      success: true,
      comments: comments.map((c) => ({ ...serializeComment(c), replies: byParent[String(c._id)] || [] })),
    });
  } catch (err) {
    console.error('[listComments]', err);
    return res.status(500).json({ success: false, message: 'Could not load comments' });
  }
};

// POST /api/posts/:postId/comments  { text, parentComment? }
exports.addComment = async (req, res) => {
  try {
    const { text, parentComment } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, message: 'Comment text is required' });

    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    const comment = await Comment.create({
      post: post._id,
      author: req.user._id,
      text: text.trim(),
      parentComment: parentComment || null,
    });

    post.commentCount += 1;
    await post.save();

    const populated = await comment.populate('author', 'name username avatarUrl');

    if (parentComment) {
      const parent = await Comment.findById(parentComment).select('author');
      if (parent) {
        notify(req.app.get('io'), {
          recipient: parent.author,
          actor: req.user._id,
          type: 'comment',
          post: post._id,
          comment: comment._id,
          text: text.trim().slice(0, 120),
        });
      }
    } else {
      notify(req.app.get('io'), {
        recipient: post.author,
        actor: req.user._id,
        type: 'comment',
        post: post._id,
        comment: comment._id,
        text: text.trim().slice(0, 120),
      });
    }

    return res.status(201).json({ success: true, comment: serializeComment(populated) });
  } catch (err) {
    console.error('[addComment]', err);
    return res.status(500).json({ success: false, message: 'Could not add comment' });
  }
};

// DELETE /api/comments/:commentId
exports.deleteComment = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found' });
    if (String(comment.author) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    comment.isDeleted = true;
    comment.text = '[deleted]';
    await comment.save();

    await Post.findByIdAndUpdate(comment.post, { $inc: { commentCount: -1 } });

    return res.json({ success: true, message: 'Comment deleted' });
  } catch (err) {
    console.error('[deleteComment]', err);
    return res.status(500).json({ success: false, message: 'Could not delete comment' });
  }
};

// POST /api/comments/:commentId/like
exports.likeComment = async (req, res) => {
  try {
    const comment = await Comment.findByIdAndUpdate(
      req.params.commentId,
      { $addToSet: { likes: req.user._id } },
      { new: true }
    );
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found' });
    return res.json({ success: true, likeCount: comment.likes.length });
  } catch (err) {
    console.error('[likeComment]', err);
    return res.status(500).json({ success: false, message: 'Could not like comment' });
  }
};
