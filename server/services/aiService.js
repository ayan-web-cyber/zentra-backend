// Section 38 — AI features are explicitly optional in the master spec ("Do not make AI
// functionality mandatory for the basic application... modular service so an AI provider
// can be changed later"). This module is that seam: everything above it (aiController,
// routes, the frontend AI Assist menu) talks to the three functions below and never knows
// or cares which provider — or none — is configured.
//
// AI_PROVIDER=none (default): every call returns a clear "not configured" result instead
//   of silently failing or faking output. That satisfies section 51's rule against fake
//   functionality — a pending feature is marked pending, not simulated.
// AI_PROVIDER=anthropic: uses ANTHROPIC_API_KEY against the Messages API. Paid, per-token.
// AI_PROVIDER=groq: uses GROQ_API_KEY against Groq's free-tier, OpenAI-compatible chat
//   completions endpoint. No cost, but free-tier models/limits change over time — check
//   https://console.groq.com/docs/models for what's currently available if AI_MODEL
//   below stops working, and swap it in .env without touching this file.
// Adding a further provider later means adding one more branch here — nothing else changes.

const PROVIDER = (process.env.AI_PROVIDER || 'none').toLowerCase();
const ANTHROPIC_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-5';
const GROQ_MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';

function isConfigured() {
  if (PROVIDER === 'none') return false;
  if (PROVIDER === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (PROVIDER === 'groq') return Boolean(process.env.GROQ_API_KEY);
  return false;
}

// callAnthropicMessages/callGroqMessages are the real provider calls — everything else
// (complete, chat, and the caption/rewrite/translate helpers below) is built on top of
// these two so there's exactly one place per provider that touches the network.
async function callAnthropicMessages(messages, { system, maxTokens = 300 } = {}) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`AI provider request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  return (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// Groq's endpoint is OpenAI-compatible (chat/completions with choices[0].message.content),
// which is why this looks different in shape from callAnthropicMessages above despite doing
// the same job — each provider function speaks that provider's native wire format; complete()
// and chat() below are what normalize them into one interface for the rest of the app.
async function callGroqMessages(messages, { system, maxTokens = 300 } = {}) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: maxTokens,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`AI provider request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function callMessages(messages, opts) {
  if (!isConfigured()) {
    const err = new Error('AI features are not configured on this server yet.');
    err.notConfigured = true;
    throw err;
  }
  if (PROVIDER === 'anthropic') return callAnthropicMessages(messages, opts);
  if (PROVIDER === 'groq') return callGroqMessages(messages, opts);
  throw new Error(`Unsupported AI_PROVIDER: ${PROVIDER}`);
}

async function complete(prompt, maxTokens) {
  return callMessages([{ role: 'user', content: prompt }], { maxTokens });
}

// General-purpose Q&A chat (the "ask anything" AI Chat page), as opposed to the
// caption/rewrite/translate helpers below which are narrow, single-shot content tools.
// `history` is the full prior conversation as [{role: 'user'|'assistant', content}], oldest
// first — the caller (aiController) is responsible for trimming it to a sane length before
// it gets here; this function doesn't second-guess how much context it was handed.
const CHAT_SYSTEM_PROMPT = [
  'You are the AI assistant built into Zentra, a social media platform.',
  'Answer the user\'s question directly and helpfully, on any topic — you are not limited to',
  'talking about the app itself. Keep answers reasonably concise unless the question calls',
  'for depth. Use plain text (no markdown tables); short paragraphs or a simple dashed list',
  'are fine when useful.',
].join(' ');

async function chat(history) {
  return callMessages(history, { system: CHAT_SYSTEM_PROMPT, maxTokens: 700 });
}

// Names an AI Chat thread from its opening exchange, so the history list reads like
// "Fixing a Mongoose index" rather than a wall of truncated first messages. Called exactly
// once per thread (aiController guards on conversation.titleGenerated) and only AFTER the
// real reply has already been sent, so a failure here can never cost the user their answer
// — the caller catches and falls back to a truncated first message.
//
// maxTokens is deliberately tiny: this is a second billed request on top of the user's turn,
// so it's kept as cheap as a request can be. The model still occasionally wraps the title in
// quotes or tacks on a full stop despite being told not to, hence the cleanup below rather
// than trusting the raw string.
async function generateTitle({ userMessage, assistantMessage }) {
  const prompt = [
    'Write a short title for the following conversation, describing what it is about.',
    'Rules: 2 to 6 words, no quotes, no trailing punctuation, no prefix like "Title:".',
    'Use the same language the user wrote in. Return ONLY the title.',
    '',
    `User: ${userMessage.slice(0, 1000)}`,
    `Assistant: ${assistantMessage.slice(0, 600)}`,
  ].join('\n');

  const raw = await complete(prompt, 24);
  const cleaned = raw
    .split('\n')[0]
    .replace(/^(title|chat)\s*[:\-–]\s*/i, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim();

  return cleaned.slice(0, 80);
}

// Generates 3 short caption ideas from a rough description of what the post is about.
async function generateCaptions({ description, mood }) {
  const prompt = [
    'You are writing short, engaging social media captions for a post on Zentra,',
    'a modern social platform. Given a rough description of the post, suggest exactly 3',
    'distinct caption options. Keep each under 25 words. Vary the tone (one punchy, one',
    'warm/personal, one a bit witty). Return ONLY a JSON array of 3 strings, nothing else.',
    '',
    `Post description: ${description}`,
    mood ? `Mood: ${mood}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await complete(prompt, 300);
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (Array.isArray(parsed)) return parsed.slice(0, 3).map(String);
  } catch {
    // fall through to a single-suggestion fallback below
  }
  return [raw];
}

// Rewrites/improves an existing caption in a requested style.
async function rewriteCaption({ text, style }) {
  const prompt = [
    `Rewrite the following social media caption to be ${style || 'clearer and more engaging'}.`,
    'Keep the original meaning and roughly the same length. Return ONLY the rewritten caption,',
    'no quotes, no preamble.',
    '',
    `Original: ${text}`,
  ].join('\n');

  return complete(prompt, 200);
}

// Translates a caption into a target language.
async function translateText({ text, targetLanguage }) {
  const prompt = [
    `Translate the following social media caption into ${targetLanguage}.`,
    'Keep the tone and any emoji. Return ONLY the translation, no quotes, no preamble.',
    '',
    `Text: ${text}`,
  ].join('\n');

  return complete(prompt, 300);
}

module.exports = {
  isConfigured,
  generateCaptions,
  rewriteCaption,
  translateText,
  chat,
  generateTitle,
  PROVIDER,
};
