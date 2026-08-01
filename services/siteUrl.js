/**
 * Where the frontend lives — with a default, because the alternative bites.
 *
 * `${process.env.FRONTEND_URL}/events` with the variable unset does not throw.
 * It produces the string "undefined/events", which then goes to Stripe as a
 * return_url and is rejected as an invalid URL. The host sees "could not start
 * payout setup" and has no way to know the cause was a missing environment
 * variable on a server they cannot see.
 *
 * So: one helper, one default, and nowhere left that interpolates the raw
 * variable. A misconfigured deploy should degrade to the right domain, not to
 * the literal word "undefined".
 */
const DEFAULT_SITE = 'https://www.theclockworkhub.com';

function siteUrl() {
  const v = String(process.env.FRONTEND_URL || process.env.SITE_URL || '').trim();
  if (!v || v === 'undefined' || v === 'null') return DEFAULT_SITE;
  return v.replace(/\/+$/, '');            // no trailing slash, so `${site()}/x` is safe
}

/** siteUrl() + a path, with exactly one slash between them. */
function siteLink(path) {
  const p = String(path || '');
  return siteUrl() + (p.startsWith('/') ? p : '/' + p);
}

module.exports = { siteUrl, siteLink, DEFAULT_SITE };
