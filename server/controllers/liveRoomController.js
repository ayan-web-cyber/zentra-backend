const LiveRoom = require('../models/LiveRoom');

function serializeRoom(room) {
  const obj = room.toObject ? room.toObject() : room;
  return {
    _id: obj._id,
    id: obj._id,
    title: obj.title,
    status: obj.status,
    host: obj.host,
    community: obj.community,
    participantCount: obj.participants?.length || 0,
    peakViewers: obj.peakViewers || 0,
    startedAt: obj.startedAt,
    endedAt: obj.endedAt,
  };
}

// GET /api/live-rooms — currently-live rooms, most recently started first
exports.listLiveRooms = async (req, res) => {
  try {
    const rooms = await LiveRoom.find({ status: 'live' })
      .populate('host', 'name username avatarUrl')
      .populate('community', 'name slug icon')
      .sort({ startedAt: -1 })
      .limit(50);
    return res.json({ success: true, rooms: rooms.map(serializeRoom) });
  } catch (err) {
    console.error('[listLiveRooms]', err);
    return res.status(500).json({ success: false, message: 'Could not load live rooms' });
  }
};

// POST /api/live-rooms — go live. One live room per host at a time.
exports.startLiveRoom = async (req, res) => {
  try {
    const { title, communityId } = req.body;
    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: 'A title is required to go live' });
    }

    const existing = await LiveRoom.findOne({ host: req.user._id, status: 'live' });
    if (existing) {
      return res.status(409).json({ success: false, message: 'You already have a live room running', room: serializeRoom(existing) });
    }

    const room = await LiveRoom.create({
      host: req.user._id,
      title: title.trim(),
      community: communityId || null,
      participants: [req.user._id],
    });
    const populated = await room.populate([
      { path: 'host', select: 'name username avatarUrl' },
      { path: 'community', select: 'name slug icon' },
    ]);
    return res.status(201).json({ success: true, room: serializeRoom(populated) });
  } catch (err) {
    console.error('[startLiveRoom]', err);
    return res.status(500).json({ success: false, message: 'Could not start the live room' });
  }
};

// GET /api/live-rooms/:roomId
exports.getLiveRoom = async (req, res) => {
  try {
    const room = await LiveRoom.findById(req.params.roomId)
      .populate('host', 'name username avatarUrl')
      .populate('community', 'name slug icon');
    if (!room) return res.status(404).json({ success: false, message: 'Live room not found' });
    return res.json({ success: true, room: serializeRoom(room) });
  } catch (err) {
    console.error('[getLiveRoom]', err);
    return res.status(500).json({ success: false, message: 'Could not load the live room' });
  }
};

// POST /api/live-rooms/:roomId/end — host-only. Socket layer also calls this logic path
// indirectly via liveroom:end for the case where the host just closes the tab.
exports.endLiveRoom = async (req, res) => {
  try {
    const room = await LiveRoom.findById(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, message: 'Live room not found' });
    if (String(room.host) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Only the host can end this room' });
    }
    if (room.status === 'ended') {
      return res.json({ success: true, room: serializeRoom(room) });
    }
    room.status = 'ended';
    room.endedAt = new Date();
    await room.save();
    return res.json({ success: true, room: serializeRoom(room) });
  } catch (err) {
    console.error('[endLiveRoom]', err);
    return res.status(500).json({ success: false, message: 'Could not end the live room' });
  }
};

exports.serializeRoom = serializeRoom;
