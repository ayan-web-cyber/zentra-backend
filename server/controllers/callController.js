const Call = require('../models/Call');

// Twilio Network Traversal Service (NTS): the Account SID + Auth Token are secrets that
// never leave this server. Each call to this function mints a fresh, short-lived
// username/password pair (Twilio calls it a "Token") scoped to `ttl` seconds — that's
// what's safe to hand to the browser. Returns null (rather than throwing) when Twilio
// isn't configured, so the caller can fall back to public STUN without treating "not set
// up yet" as an error.
async function getTwilioIceServers() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;

  const ttl = Number(process.env.TWILIO_NTS_TTL_SECONDS) || 86400;
  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ Ttl: String(ttl) }),
  });

  if (!response.ok) {
    throw new Error(`Twilio NTS token request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  // Twilio's REST response uses ice_servers/url; normalize to the { urls, username,
  // credential } shape RTCPeerConnection expects.
  return (data.ice_servers || []).map((s) => ({
    urls: s.urls || s.url,
    username: s.username,
    credential: s.credential,
  }));
}

// GET /api/calls — history, most recent first
exports.getCallHistory = async (req, res) => {
  try {
    const calls = await Call.find({ $or: [{ caller: req.user._id }, { callee: req.user._id }] })
      .sort('-createdAt')
      .limit(50)
      .populate('caller', 'name username avatarUrl')
      .populate('callee', 'name username avatarUrl');

    return res.json({
      success: true,
      calls: calls.map((c) => ({
        _id: c._id,
        type: c.type,
        status: c.status,
        durationSeconds: c.durationSeconds,
        createdAt: c.createdAt,
        isOutgoing: String(c.caller._id) === String(req.user._id),
        otherParty: String(c.caller._id) === String(req.user._id) ? c.callee : c.caller,
      })),
    });
  } catch (err) {
    console.error('[getCallHistory]', err);
    return res.status(500).json({ success: false, message: 'Could not load call history' });
  }
};

// GET /api/calls/ice-servers — Twilio Network Traversal Service when configured (no server
// to run or maintain), else public STUN with an optional self-hosted TURN fallback
// (section 27: don't assume peer-to-peer always works, but don't require any account at
// all just to try the feature).
exports.getIceServers = async (req, res) => {
  try {
    const twilioServers = await getTwilioIceServers();
    if (twilioServers) {
      return res.json({ success: true, iceServers: twilioServers, provider: 'twilio' });
    }
  } catch (err) {
    console.error('[getIceServers] Twilio NTS request failed, falling back to STUN:', err.message);
  }

  const servers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  if (process.env.TURN_SERVER_URL) {
    servers.push({
      urls: process.env.TURN_SERVER_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  return res.json({ success: true, iceServers: servers, provider: 'fallback' });
};
