/**
 * What does this job actually pay?
 *
 * Measured against the live corpus before this was written: only 1% of
 * engineering postings expose a structured salary field, but 52% state pay
 * somewhere in the job description — pay-transparency laws in Colorado, NYC,
 * California and Washington force the number into the prose. So compensation
 * is read out of text, not off a field, and that is why this file exists.
 *
 * Everything here is deliberately conservative. A wrong salary is worse than
 * no salary: it decides which role gets called "highest paid", and a stray
 * "$100,000 in equity" or "raised $50,000,000" parsed as a wage would send
 * somebody after the wrong job. So:
 *
 *   - a range is preferred over a single figure
 *   - hourly and monthly are converted, and marked as converted
 *   - anything outside a believable band for salaried work is discarded
 *   - funding, revenue, and bonus figures are excluded by context, not hope
 *   - `confidence` travels with the number so the ranker can prefer a stated
 *     range over an inferred one
 */

// Believable annual base for a salaried engineer, worldwide, in USD-ish terms.
// Anything outside this is a funding round, a signing bonus, or a typo.
const MIN_ANNUAL = 20000;
const MAX_ANNUAL = 1200000;
const MIN_HOURLY = 10;
const MAX_HOURLY = 800;
const MIN_MONTHLY = 1500;
const MAX_MONTHLY = 100000;

const HOURS_PER_YEAR = 2080;   // 40h × 52w, the US convention these postings use

// Phrases that mean the money is NOT a wage. Checked in a window around the
// figure, because "we raised $50M" and "the base range is $150k" look
// identical to a number-matcher.
const NOT_PAY = /\b(raise[ds]?|raising|funding|valuation|valued|revenue|arr|mrr|market cap|series\s+[a-f]\b|investment|invested|budget|savings|grant|donat|customers?|users?|deal size|quota|pipeline|portfolio|aum|transactions?)\b/i;

// Equity and bonuses are real money but not the base, and mixing them in makes
// two jobs incomparable. Detected so they can be excluded from base.
const NOT_BASE = /\b(equity|stock|option|rsu|signing bonus|sign-on|relocation|401\(?k\)?|bonus target|annual bonus|commission)\b/i;

const CURRENCY = {
  '$': 'USD', 'us$': 'USD', 'usd': 'USD', '£': 'GBP', 'gbp': 'GBP',
  '€': 'EUR', 'eur': 'EUR', 'c$': 'CAD', 'cad': 'CAD', 'a$': 'AUD', 'aud': 'AUD',
  '₹': 'INR', 'inr': 'INR', 'chf': 'CHF', 'sek': 'SEK', 'pln': 'PLN', '¥': 'JPY'
};

/** "150k" → 150000, "150,000" → 150000, "150.5k" → 150500. */
function num(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim().toLowerCase().replace(/[, ]/g, '');
  // European thousands separator. "€355.000" is 355 thousand, not 355 point
  // zero — and read the wrong way it becomes a small number, gets inferred as
  // an hourly rate, and is multiplied by 2080 into a €738k salary. That was
  // the single largest source of nonsense in the first pass over the corpus.
  // A dot followed by exactly three digits, one or more times, is never a
  // decimal fraction in a wage.
  if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  let mult = 1;
  if (s.endsWith('k')) { mult = 1000; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1000000; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n * mult;
}

function currencyOf(window) {
  const m = String(window).toLowerCase().match(/us\$|c\$|a\$|usd|gbp|eur|cad|aud|inr|chf|sek|pln|[$£€₹¥]/);
  return m ? (CURRENCY[m[0]] || 'USD') : 'USD';
}

/**
 * Which unit is this figure in? Read from the words around it rather than the
 * magnitude — "$85 per hour" and "$85,000 a year" both start with $85.
 */
function periodOf(window, value) {
  const w = String(window).toLowerCase();
  if (/\b(per|an|\/)\s*(hour|hr)\b|\bhourly\b|\/hr\b|\bph\b/.test(w)) return 'hour';
  if (/\b(per|a|\/)\s*(month|mo)\b|\bmonthly\b|\/mo\b/.test(w)) return 'month';
  if (/\b(per|a|\/)\s*(year|annum|yr)\b|\bannual|\byearly\b|\/yr\b|\bpa\b/.test(w)) return 'year';
  // Unstated: fall back to magnitude, which is unambiguous at the extremes.
  if (value >= 10000) return 'year';
  if (value <= 500) return 'hour';
  return 'month';
}

function toAnnual(value, period) {
  if (period === 'hour') {
    if (value < MIN_HOURLY || value > MAX_HOURLY) return null;
    return Math.round(value * HOURS_PER_YEAR);
  }
  if (period === 'month') {
    if (value < MIN_MONTHLY || value > MAX_MONTHLY) return null;
    return Math.round(value * 12);
  }
  if (value < MIN_ANNUAL || value > MAX_ANNUAL) return null;
  return Math.round(value);
}

// A range: "$150,000 - $200,000", "$150k–$200k", "150,000 to 200,000 USD".
const RANGE = /(?:us\$|c\$|a\$|usd|gbp|eur|cad|aud|inr|chf|sek|pln|[$£€₹¥])\s?([\d][\d,.]*\s?[km]?)\s*(?:-|–|—|to|up to|and)\s*(?:us\$|c\$|a\$|usd|gbp|eur|cad|aud|inr|chf|sek|pln|[$£€₹¥])?\s?([\d][\d,.]*\s?[km]?)/gi;
// A single figure, used only when no range is found.
const SINGLE = /(?:us\$|c\$|a\$|usd|gbp|eur|cad|aud|inr|chf|sek|pln|[$£€₹¥])\s?([\d][\d,.]*\s?[km]?)/gi;

/** ±90 characters of context — enough for "the base salary range for this role". */
function windowAround(text, index, len) {
  return text.slice(Math.max(0, index - 90), Math.min(text.length, index + len + 90));
}

/**
 * Pull compensation from whatever text we have.
 *
 * Returns null when there is nothing trustworthy — which is the correct answer
 * about half the time and much better than a guess.
 */
function extractSalary(...texts) {
  const text = texts.filter(Boolean).join('\n').replace(/\s+/g, ' ');
  if (!text || text.length < 3) return null;

  const candidates = [];

  RANGE.lastIndex = 0;
  let m;
  while ((m = RANGE.exec(text))) {
    const win = windowAround(text, m.index, m[0].length);
    if (NOT_PAY.test(win)) continue;
    const period = periodOf(win, num(m[1]));
    const lo = toAnnual(num(m[1]), period), hi = toAnnual(num(m[2]), period);
    if (lo == null || hi == null || hi < lo) continue;
    // A posted band is rarely wider than about 2.5x. Anything wider is two
    // unrelated figures that happened to sit next to a dash — a location table,
    // or a base range abutting an equity range.
    if (hi > lo * 4) continue;
    candidates.push({
      // Read the currency off the MATCH, not the surrounding window: a window
      // wide enough to catch "base salary range" also catches a different
      // currency mentioned a sentence earlier, which is how a US role ended up
      // priced in euros.
      minAnnual: lo, maxAnnual: hi, currency: currencyOf(m[0]) || currencyOf(win),
      period, isRange: true, converted: period !== 'year',
      // A range stated near the words "base salary" is the thing we want; a
      // range near "equity" is not comparable to one.
      base: !NOT_BASE.test(win),
      confidence: NOT_BASE.test(win) ? 0.6 : 0.9,
      evidence: m[0].trim().slice(0, 80)
    });
  }

  if (!candidates.length) {
    SINGLE.lastIndex = 0;
    while ((m = SINGLE.exec(text))) {
      const win = windowAround(text, m.index, m[0].length);
      if (NOT_PAY.test(win) || NOT_BASE.test(win)) continue;
      // A bare figure only counts when something nearby says it is pay.
      if (!/\b(salary|compensation|pay|base|rate|earn|wage|offer)\b/i.test(win)) continue;
      const v = num(m[1]);
      const period = periodOf(win, v);
      const a = toAnnual(v, period);
      if (a == null) continue;
      candidates.push({
        minAnnual: a, maxAnnual: a, currency: currencyOf(m[0]) || currencyOf(win),
        period, isRange: false, converted: period !== 'year', base: true,
        confidence: 0.55, evidence: m[0].trim().slice(0, 80)
      });
    }
  }

  if (!candidates.length) return null;

  // Prefer a confident base range; among equals prefer the widest, which is
  // almost always the full posted band rather than one level inside it.
  candidates.sort((a, b) =>
    (b.confidence - a.confidence) ||
    ((b.maxAnnual - b.minAnnual) - (a.maxAnnual - a.minAnnual)));
  const best = candidates[0];
  return {
    minAnnual: best.minAnnual,
    maxAnnual: best.maxAnnual,
    // One number to sort by. The midpoint of a posted band is what a candidate
    // can reasonably expect; the top of the band is what the posting advertises.
    midAnnual: Math.round((best.minAnnual + best.maxAnnual) / 2),
    currency: best.currency,
    period: best.period,
    isRange: best.isRange,
    converted: best.converted,
    confidence: best.confidence,
    evidence: best.evidence
  };
}

/** Human-readable, for the queue and the comparison table. */
function formatSalary(s) {
  if (!s) return '';
  const sym = { USD: '$', GBP: '£', EUR: '€', CAD: 'C$', AUD: 'A$', INR: '₹', JPY: '¥' }[s.currency] || '';
  const k = n => n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
  const body = s.isRange && s.maxAnnual !== s.minAnnual
    ? `${sym}${k(s.minAnnual)}–${sym}${k(s.maxAnnual)}`
    : `${sym}${k(s.midAnnual)}`;
  return body + (s.converted ? ` (from ${s.period}ly)` : '');
}

module.exports = { extractSalary, formatSalary, num, periodOf, toAnnual, MIN_ANNUAL, MAX_ANNUAL };
