const Event = require('../models/Event');
const Community = require('../models/Community');

const POPULATE = [
  { path: 'cover' },
  { path: 'organizer', select: 'name username avatarUrl' },
  { path: 'community', select: 'name slug icon' },
];

function serializeEvent(event, viewerId) {
  const obj = event.toObject();
  return {
    ...obj,
    cover: obj.cover ? { id: obj.cover._id, url: `/api/media/${obj.cover.gridfsId}` } : null,
    interestedCount: obj.interested.length,
    goingCount: obj.going.length,
    myStatus: viewerId
      ? obj.going.some((u) => String(u) === String(viewerId))
        ? 'going'
        : obj.interested.some((u) => String(u) === String(viewerId))
        ? 'interested'
        : 'none'
      : 'none',
    isOrganizer: viewerId ? String(obj.organizer?._id || obj.organizer) === String(viewerId) : false,
    interested: undefined,
    going: undefined,
  };
}

// GET /api/events?when=upcoming|past&communityId=&mine=
exports.listEvents = async (req, res) => {
  try {
    const { when = 'upcoming', communityId, mine } = req.query;
    const query = {};
    if (communityId) query.community = communityId;
    if (when === 'upcoming') query.startAt = { $gte: new Date() };
    if (when === 'past') query.startAt = { $lt: new Date() };
    if (mine === 'true' && req.user) {
      query.$or = [{ organizer: req.user._id }, { interested: req.user._id }, { going: req.user._id }];
    }

    const events = await Event.find(query)
      .sort({ startAt: when === 'past' ? -1 : 1 })
      .limit(50)
      .populate(POPULATE);

    return res.json({ success: true, events: events.map((e) => serializeEvent(e, req.user?._id)) });
  } catch (err) {
    console.error('[listEvents]', err);
    return res.status(500).json({ success: false, message: 'Could not load events' });
  }
};

// POST /api/events
exports.createEvent = async (req, res) => {
  try {
    const { name, description, coverId, startAt, endAt, isOnline, location, communityId } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Event name is required' });
    if (!startAt || Number.isNaN(Date.parse(startAt))) {
      return res.status(400).json({ success: false, message: 'A valid start date/time is required' });
    }

    if (communityId) {
      const community = await Community.findById(communityId);
      if (!community) return res.status(404).json({ success: false, message: 'Community not found' });
      if (!community.members.some((m) => String(m) === String(req.user._id))) {
        return res.status(403).json({ success: false, message: 'Join the community to create events there' });
      }
    }

    const event = await Event.create({
      name: name.trim(),
      description: description || '',
      cover: coverId || null,
      startAt: new Date(startAt),
      endAt: endAt && !Number.isNaN(Date.parse(endAt)) ? new Date(endAt) : null,
      isOnline: Boolean(isOnline),
      location: location || '',
      organizer: req.user._id,
      community: communityId || null,
      going: [req.user._id], // organizer is automatically "going" to their own event
    });

    const populated = await Event.findById(event._id).populate(POPULATE);
    return res.status(201).json({ success: true, event: serializeEvent(populated, req.user._id) });
  } catch (err) {
    console.error('[createEvent]', err);
    return res.status(500).json({ success: false, message: 'Could not create event' });
  }
};

// GET /api/events/:eventId
exports.getEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId).populate(POPULATE);
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });
    return res.json({ success: true, event: serializeEvent(event, req.user?._id) });
  } catch (err) {
    console.error('[getEvent]', err);
    return res.status(500).json({ success: false, message: 'Could not load event' });
  }
};

// PUT /api/events/:eventId — organizer only
exports.updateEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });
    if (String(event.organizer) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Only the organizer can edit this event' });
    }

    const { name, description, coverId, startAt, endAt, isOnline, location } = req.body;
    if (name?.trim()) event.name = name.trim();
    if (description !== undefined) event.description = description;
    if (coverId !== undefined) event.cover = coverId || null;
    if (startAt && !Number.isNaN(Date.parse(startAt))) event.startAt = new Date(startAt);
    if (endAt !== undefined) event.endAt = endAt && !Number.isNaN(Date.parse(endAt)) ? new Date(endAt) : null;
    if (isOnline !== undefined) event.isOnline = Boolean(isOnline);
    if (location !== undefined) event.location = location;
    await event.save();

    const populated = await Event.findById(event._id).populate(POPULATE);
    return res.json({ success: true, event: serializeEvent(populated, req.user._id) });
  } catch (err) {
    console.error('[updateEvent]', err);
    return res.status(500).json({ success: false, message: 'Could not update event' });
  }
};

// DELETE /api/events/:eventId — organizer only
exports.deleteEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });
    if (String(event.organizer) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Only the organizer can delete this event' });
    }
    await event.deleteOne();
    return res.json({ success: true, message: 'Event deleted' });
  } catch (err) {
    console.error('[deleteEvent]', err);
    return res.status(500).json({ success: false, message: 'Could not delete event' });
  }
};

// POST /api/events/:eventId/rsvp  { status: 'interested' | 'going' | 'not_interested' }
exports.rsvpEvent = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['interested', 'going', 'not_interested'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid RSVP status' });
    }

    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });

    const uid = String(req.user._id);
    event.interested = event.interested.filter((u) => String(u) !== uid);
    event.going = event.going.filter((u) => String(u) !== uid);
    if (status === 'interested') event.interested.push(req.user._id);
    if (status === 'going') event.going.push(req.user._id);
    await event.save();

    return res.json({
      success: true,
      myStatus: status,
      interestedCount: event.interested.length,
      goingCount: event.going.length,
    });
  } catch (err) {
    console.error('[rsvpEvent]', err);
    return res.status(500).json({ success: false, message: 'Could not update RSVP' });
  }
};
