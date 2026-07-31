/**
 * contentFilter — brand safety for the Signal / What's happening feeds.
 *
 * The Hub's feeds are a front page, not a wire service. Sexual-violence and
 * graphic-crime headlines have no place on it, and one slipped through from a
 * general-news source that has since been dropped from the feed list.
 *
 * Applied in TWO places, which is the point:
 *   • rssAggregator  — at ingest, so nothing new is ever stored.
 *   • NewsController — at query, because items stored BEFORE this existed are
 *                      still in the database and would keep surfacing.
 *
 * Deliberately narrow. This is not a profanity filter and not a politics
 * filter — it targets sexual violence and child abuse only, so ordinary hard
 * news (war, elections, courts, disasters) still comes through. Broadening it
 * would quietly gut the feed.
 */

// Word-boundary anchored so 'therapist' can't trip 'rapist' and 'grape' can't
// trip 'rape'.
const BLOCKED = [
  'rape', 'raped', 'rapes', 'rapist', 'rapists',
  'sexual assault', 'sexually assaulted', 'sex assault',
  'sexual abuse', 'sexually abused', 'sex abuse',
  'molest', 'molested', 'molester', 'molestation',
  'paedophile', 'pedophile', 'paedophilia', 'pedophilia',
  'child abuse', 'child sex', 'child porn', 'csam',
  'incest', 'revenge porn', 'upskirt', 'sex trafficking',
  // The list above names the ACT, which let the offender/registry framing walk
  // straight through: "Registered sex offender arrested in ..." matched nothing
  // and would have surfaced on the front page. Same category, different noun.
  'sex offender', 'sex offenders', 'sexual offender', 'sexual offenders',
  'sex offender registry', 'sexual predator', 'sexual predators',
  'child predator', 'child predators', 'child exploitation',
  'sextortion', 'indecent assault', 'indecent exposure',
  'statutory rape', 'sexual misconduct', 'sexual harassment'
];

const BLOCK_RE = new RegExp('\\b(' + BLOCKED.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');

/** True when this text should never reach a feed. */
function isBlocked(text) {
  return BLOCK_RE.test(String(text || ''));
}

/** True when any of the supplied strings is blocked (title, summary, …). */
function anyBlocked(...parts) {
  return parts.some(isBlocked);
}

/**
 * A Mongo clause that excludes blocked headlines at query time. Spread into an
 * existing query object: { ...q, ...titleNotBlocked() }
 */
function titleNotBlocked(field = 'title') {
  return { [field]: { $not: BLOCK_RE } };
}

module.exports = { BLOCK_RE, BLOCKED, isBlocked, anyBlocked, titleNotBlocked };
