/**
 * Social link normalization — one truth for save AND read.
 *
 * Handles are welcome: "itssjoshl" / "@itssjoshl" become the platform URL
 * (instagram.com/itssjoshl, youtube.com/@itssjoshl, …). Schemeless domains
 * get https://. Anything that can't form a real host returns '' so callers
 * drop it instead of serving a broken link. Reading through this repairs
 * values stored before normalization existed.
 */
const LINK_HOME = {
  x: 'x.com/', instagram: 'instagram.com/', facebook: 'facebook.com/',
  twitch: 'twitch.tv/', youtube: 'youtube.com/@', tiktok: 'tiktok.com/@',
  linkedin: 'linkedin.com/in/', github: 'github.com/'
};

function normalizeLink(key, raw) {
  let v = String(raw || '').trim().slice(0, 200);
  if (!v) return '';
  v = v.replace(/^https?:\/\//i, '').replace(/^\/+/, '');
  if (v.startsWith('@')) v = v.slice(1);
  if (!v.includes('.') && LINK_HOME[key]) v = LINK_HOME[key] + v;
  v = 'https://' + v;
  try {
    const p = new URL(v);
    if (p.protocol !== 'https:') return '';
    if (!p.hostname.includes('.')) return '';
  } catch (e) { return ''; }
  return v;
}

// Repair a whole links object on the way out of the API.
function normalizeLinks(links) {
  const out = {};
  if (!links || typeof links !== 'object') return out;
  const src = links.toObject ? links.toObject() : links;
  for (const k of Object.keys(src)) {
    const v = normalizeLink(k, src[k]);
    if (v) out[k] = v;
  }
  return out;
}

module.exports = { normalizeLink, normalizeLinks, LINK_HOME };
