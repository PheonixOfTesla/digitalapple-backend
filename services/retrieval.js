/**
 * retrieval.js — real, citable grounding for map generation.
 *
 * Uses Wikipedia's public API (no key, reputable, canonical URLs) to fetch real
 * source text for a premise's subject. That text is injected into the generation
 * prompt so the model states figures/dates/names ONLY from a real source, and the
 * real source URL is attached to the map for citation.
 *
 * Grounding is best-effort: any failure returns null and generation proceeds
 * ungrounded (the prompt then forbids unsourced specifics).
 */

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKI_REST = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const UA = 'ClockworkHub/1.0 (https://theclockworkhub.com; maps@theclockworkhub.com)';

async function getJson(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Strip common premise stems to isolate the subject (person / company / topic).
function extractSubject(premise) {
  if (!premise) return '';
  let s = String(premise);
  // leading question stems
  s = s.replace(/^\s*(how did|how does|how do|how to|how i|what made|what really caused|the rise of|the economics of|the science of how to|why is|why are|why do|why does)\b/i, '');
  // trailing angle phrases (biographical + company action verbs)
  s = s.replace(/\b(get famous|got famous|make their money|made their money|make money|build their empire|built their empire|become successful|became successful|become|became|beat|beats|win|wins|won|conquer|conquered|take over|took over|dominate|dominated|survive|survived|reinvent|reinvented|disrupt|disrupted|build|built|grow|grew|happen|happened|actually works?|work|works)\b.*$/i, '');
  // possessives / filler
  s = s.replace(/\b(their|his|her|its|the)\b\s*$/i, '');
  return s.trim().replace(/\s+/g, ' ');
}

async function searchTitle(query) {
  const url = `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1&origin=*`;
  const d = await getJson(url);
  const hit = d && d.query && d.query.search && d.query.search[0];
  return hit ? hit.title : null;
}

async function getSummary(title) {
  const url = `${WIKI_REST}${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const d = await getJson(url);
  if (!d || d.type === 'disambiguation' || !d.extract) return null;
  return {
    title: d.title,
    extract: d.extract,
    url: (d.content_urls && d.content_urls.desktop && d.content_urls.desktop.page) || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
  };
}

// Longer plain-text intro extract for richer grounding.
async function getIntroExtract(title) {
  const url = `${WIKI_API}?action=query&prop=extracts&exintro=&explaintext=&redirects=1&format=json&origin=*&titles=${encodeURIComponent(title)}`;
  const d = await getJson(url);
  const pages = d && d.query && d.query.pages;
  if (!pages) return null;
  const p = Object.values(pages)[0];
  return (p && p.extract) || null;
}

/**
 * Retrieve grounding for a premise. Returns:
 *   { text, source: { name, url, handle, kind }, title }  or  null
 */
async function retrieveContext(premise, { maxChars = 1800 } = {}) {
  try {
    const subject = extractSubject(premise) || premise;
    if (!subject || subject.length < 2) return null;
    const title = await searchTitle(subject);
    if (!title) return null;
    const summary = await getSummary(title);
    if (!summary) return null;
    let text = summary.extract;
    const longer = await getIntroExtract(title);
    if (longer && longer.length > text.length) text = longer;
    text = text.slice(0, maxChars).trim();
    if (!text) return null;
    return {
      text,
      title: summary.title,
      source: { name: `Wikipedia — ${summary.title}`, url: summary.url, handle: '', kind: 'other' }
    };
  } catch (e) {
    return null;
  }
}

module.exports = { retrieveContext, extractSubject };
