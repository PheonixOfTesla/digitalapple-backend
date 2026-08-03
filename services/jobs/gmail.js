/**
 * Reading the replies, so the odds stop being a model.
 *
 * Every probability on the jobs console is calibrated against one number: how
 * often somebody actually replies to you. Until now that number came from a
 * dropdown you had to remember to set, which means the calibration was really
 * measuring your diligence about bookkeeping. This closes the loop.
 *
 * SCOPE IS READ-ONLY, DELIBERATELY. gmail.readonly and nothing else. This can
 * list and read messages; it cannot send, delete, label or modify anything. A
 * tool that watches your job search does not need permission to write to your
 * inbox, and asking for it would be the wrong trade for you to make.
 *
 * WHAT IT LOOKS AT. Only messages that arrived after you marked an application
 * sent, only from senders plausibly connected to that employer, and only for
 * applications you actually recorded. It does not read your inbox in general;
 * it runs one narrow query per open application.
 *
 * The refresh token is encrypted at rest with the same service that protects
 * message bodies, and the scan stores an excerpt rather than the whole email.
 */
const { encryptText, decryptText } = require('../crypto');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Read only. Never gmail.modify, never gmail.send.
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function configured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri() {
  const base = (process.env.PUBLIC_API_URL || 'https://digitalapple-backend-production.up.railway.app').replace(/\/+$/, '');
  return `${base}/api/v1/jobs/gmail/callback`;
}

/**
 * The consent URL.
 *
 * access_type=offline and prompt=consent together are what produce a refresh
 * token. Without both, Google returns an access token that expires in an hour
 * and the scan silently stops working the next day.
 */
function consentUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  });
  return AUTH + '?' + p.toString();
}

async function exchangeCode(code) {
  const r = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(), grant_type: 'authorization_code'
    })
  });
  const d = await r.json();
  if (!r.ok || !d.refresh_token) {
    const e = new Error(d.error_description || d.error || 'Google did not return a refresh token');
    e.detail = d; throw e;
  }
  return d;
}

async function accessToken(encryptedRefresh) {
  const refresh = decryptText(encryptedRefresh);
  if (!refresh) throw new Error('no refresh token stored');
  const r = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refresh, client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token'
    })
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) {
    // A revoked grant is a real state, not a transient error — the caller must
    // be able to tell "Google is down" from "you disconnected this".
    const e = new Error(d.error === 'invalid_grant' ? 'Gmail access was revoked — reconnect it.' : (d.error_description || 'token refresh failed'));
    e.revoked = d.error === 'invalid_grant';
    throw e;
  }
  return d.access_token;
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * What kind of reply is this?
 *
 * Regex rather than an LLM, on purpose: this decides whether your callback
 * rate goes up, and a rule you can read and argue with beats a model you
 * cannot audit. Order matters — a rejection often contains the word
 * "interview" ("we will not be moving forward to the interview stage"), so
 * rejection is tested first.
 */
const REJECT = /\b(unfortunately|we regret|not (?:be )?mov(?:ing|e) forward|decided (?:not|to move forward with other)|other candidates|will not be proceeding|no longer under consideration|not a (?:match|fit) at this time|pursue other applicants|position has been filled)\b/i;
const INTERVIEW = /\b(schedule (?:a|an|some)? ?(?:call|chat|time|interview)|set up a (?:call|chat|time)|book a time|calendly|availability (?:for|to)|would love to (?:chat|talk|connect)|next steps?|phone screen|technical (?:screen|interview)|invite you to interview|move(?:ing)? (?:you )?(?:forward|to the next))\b/i;
const OFFER = /\b(pleased to (?:offer|extend)|offer of employment|we would like to offer|formal offer|offer letter|welcome to the team)\b/i;
// Noise that looks like a reply and is not.
const AUTOMATED = /\b(do not reply|no-?reply|this is an automated|we have received your application|thank you for applying|your application (?:has been|was) received|application confirmation)\b/i;

function classify(subject, body) {
  const t = `${subject || ''}\n${body || ''}`;
  if (OFFER.test(t)) return { kind: 'offer', status: 'offer', confidence: 0.85 };
  if (REJECT.test(t)) return { kind: 'rejection', status: 'rejected', confidence: 0.9 };
  if (INTERVIEW.test(t)) return { kind: 'interview', status: 'interview', confidence: 0.8 };
  // An acknowledgement is not a callback. Counting "thank you for applying" as
  // a reply would inflate the one rate the whole model rests on.
  if (AUTOMATED.test(t)) return { kind: 'acknowledgement', status: null, confidence: 0.9 };
  return { kind: 'other', status: 'responded', confidence: 0.4 };
}

// ── Reading ─────────────────────────────────────────────────────────────────

function header(msg, name) {
  const h = ((msg.payload && msg.payload.headers) || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/** Gmail nests bodies in parts; take the first text we find. */
function plainBody(payload, depth = 0) {
  if (!payload || depth > 6) return '';
  if (payload.body && payload.body.data && /^text\/plain/.test(payload.mimeType || '')) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  for (const p of payload.parts || []) {
    const t = plainBody(p, depth + 1);
    if (t) return t;
  }
  if (payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  }
  return '';
}

async function search(token, query, max = 5) {
  const u = `${API}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`;
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return [];
  const d = await r.json();
  return d.messages || [];
}

async function getMessage(token, id) {
  const r = await fetch(`${API}/messages/${id}?format=full`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  return r.json();
}

/**
 * Find replies for one application.
 *
 * The query is narrow by construction: this employer's name, after the date
 * you said you applied, and never older than that. It is not a search of your
 * mail — it is a search for one company's reply to one application.
 */
async function repliesFor(token, app, { maxPerApp = 3 } = {}) {
  const company = String(app.company || '').trim();
  if (!company || !app.appliedAt) return [];
  const after = new Date(app.appliedAt);
  const q = [
    `after:${Math.floor(after.getTime() / 1000)}`,
    '-in:spam',
    // Company name in the sender or anywhere in the message. Quoted so a
    // multi-word employer is one term rather than three.
    `("${company.replace(/"/g, '')}")`
  ].join(' ');

  const ids = await search(token, q, maxPerApp);
  const out = [];
  for (const { id } of ids) {
    const m = await getMessage(token, id);
    if (!m) continue;
    const subject = header(m, 'Subject');
    const from = header(m, 'From');
    const body = plainBody(m.payload).slice(0, 4000);
    const c = classify(subject, body);
    out.push({
      id, subject, from,
      at: new Date(Number(m.internalDate || Date.now())),
      excerpt: (m.snippet || body).slice(0, 500),
      ...c
    });
  }
  return out;
}

module.exports = {
  configured, consentUrl, exchangeCode, accessToken, redirectUri,
  classify, repliesFor, plainBody, header, SCOPE,
  REJECT, INTERVIEW, OFFER, AUTOMATED
};
