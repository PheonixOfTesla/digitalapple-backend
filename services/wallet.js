/**
 * wallet — Apple Wallet passes for Lightning Passes.
 *
 * WHAT THIS NEEDS FROM APPLE, AND WHY IT IS GATED
 * A .pkpass is a signed zip. The signature requires three things that only an
 * Apple Developer account can issue:
 *
 *   APPLE_PASS_TYPE_ID    the Pass Type identifier, e.g. pass.com.clockworkhub.ticket
 *   APPLE_TEAM_ID         the 10-character Team ID
 *   APPLE_PASS_CERT       the Pass Type ID certificate, PEM
 *   APPLE_PASS_KEY        its private key, PEM
 *   APPLE_PASS_KEY_PASSPHRASE  if the key is encrypted
 *   APPLE_WWDR_CERT       Apple's WWDR intermediate, PEM
 *
 * Without them nothing can be signed, and an unsigned pass is not a pass — iOS
 * rejects it outright. So `available()` is the gate: the API answers 501 and
 * the ticket page never shows the button. A button that cannot work is worse
 * than no button, especially on a ticket, where somebody may be at a door.
 *
 * The QR payload is the same recovery URL the web pass uses, so a pass in
 * Wallet and a pass in a browser scan identically at the door. There is one
 * ticket and one code; Wallet is another way to carry it, not another ticket.
 */
const fs = require('fs');
const path = require('path');

const ENV_KEYS = ['APPLE_PASS_TYPE_ID', 'APPLE_TEAM_ID', 'APPLE_PASS_CERT', 'APPLE_PASS_KEY', 'APPLE_WWDR_CERT'];

/**
 * icon.png is not decoration. A .pkpass without one is rejected outright —
 * "your pass won't be openable by any Apple Device" — and the failure happens
 * on the phone, after the download, with nothing to explain it. The files are
 * committed rather than generated at runtime so the server never needs a
 * browser to make a ticket.
 */
const ART_DIR = path.join(__dirname, '..', 'assets', 'wallet');
const ART = ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png'];

/** A PEM from either an inline env var or a path to one on disk. */
function pem(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (v.indexOf('-----BEGIN') >= 0) return v.replace(/\\n/g, '\n');
  try { return fs.readFileSync(v, 'utf8'); } catch (e) { return null; }
}

/** Which of the required pieces are missing. Empty array means ready. */
function missing() {
  const gone = ENV_KEYS.filter(k => !String(process.env[k] || '').trim());
  // A var that is set but unreadable is worse than one that is unset, because
  // it looks configured. Check the PEMs actually resolve.
  for (const k of ['APPLE_PASS_CERT', 'APPLE_PASS_KEY', 'APPLE_WWDR_CERT']) {
    if (gone.indexOf(k) < 0 && !pem(process.env[k])) gone.push(k + ' (set, but not readable as a PEM)');
  }
  // A pass with no icon downloads fine and then will not open. Treat missing
  // art as missing configuration rather than letting it ship silently.
  for (const f of ['icon.png', 'icon@2x.png']) {
    if (!fs.existsSync(path.join(ART_DIR, f))) gone.push('assets/wallet/' + f);
  }
  return gone;
}

function available() { return missing().length === 0; }

/** Colours as Wallet wants them: "rgb(r, g, b)". */
const INK = 'rgb(11, 14, 20)';
const GOLD = 'rgb(250, 204, 21)';
const PAPER = 'rgb(255, 255, 255)';

/**
 * Build a signed .pkpass for one ticket. Returns a Buffer.
 * Throws if the signing material is missing — callers check available() first.
 */
async function buildTicketPass({ ticket, event, ticketUrl, host }) {
  const gaps = missing();
  if (gaps.length) throw new Error('Apple Wallet is not configured: missing ' + gaps.join(', '));

  const { PKPass } = require('passkit-generator');

  const when = event && event.startsAt ? new Date(event.startsAt) : null;
  const venue = (event && event.venue && event.venue.name)
    ? [event.venue.name, event.venue.city].filter(Boolean).join(', ')
    : (event && event.roomId ? 'Online — Clockwork room' : '');

  // The bundle. icon.png is mandatory; the rest sharpen it on bigger screens.
  const buffers = {};
  for (const f of ART) {
    const full = path.join(ART_DIR, f);
    if (fs.existsSync(full)) buffers[f] = fs.readFileSync(full);
  }

  const pass = new PKPass(buffers, {
    wwdr: pem(process.env.APPLE_WWDR_CERT),
    signerCert: pem(process.env.APPLE_PASS_CERT),
    signerKey: pem(process.env.APPLE_PASS_KEY),
    signerKeyPassphrase: process.env.APPLE_PASS_KEY_PASSPHRASE || undefined
  }, {
    // eventTicket is the style with the strip and the perforated look; it is
    // also the one iOS surfaces on the lock screen near the start time.
    passTypeIdentifier: String(process.env.APPLE_PASS_TYPE_ID).trim(),
    teamIdentifier: String(process.env.APPLE_TEAM_ID).trim(),
    // Stable per ticket: re-issuing must UPDATE the pass in Wallet, not add a
    // second one. The code is already unique and already the identity.
    serialNumber: String(ticket.code),
    organizationName: 'Clockwork Hub',
    description: (event && event.title) ? `Lightning Pass — ${event.title}` : 'Lightning Pass',
    foregroundColor: INK,
    backgroundColor: GOLD,
    labelColor: INK,
    logoText: 'Clockwork Hub',
    ...(when ? { relevantDate: when.toISOString() } : {}),
    ...(venue ? { locations: [] } : {})
  });

  pass.type = 'eventTicket';

  pass.primaryFields.push({
    key: 'event',
    label: 'EVENT',
    value: (event && event.title) || 'Event'
  });

  if (when) {
    pass.secondaryFields.push({
      key: 'doors', label: 'DOORS',
      value: when.toISOString(),
      dateStyle: 'PKDateStyleMedium',
      timeStyle: 'PKDateStyleShort'
    });
  }
  if (venue) {
    pass.secondaryFields.push({ key: 'where', label: 'WHERE', value: venue });
  }

  pass.auxiliaryFields.push({ key: 'holder', label: 'ADMITS', value: ticket.name || ticket.email || 'One' });
  pass.auxiliaryFields.push({ key: 'tier', label: 'TYPE', value: ticket.tierName || 'Admission' });

  pass.backFields.push({ key: 'code', label: 'Pass code', value: String(ticket.code) });
  pass.backFields.push({ key: 'url', label: 'Open online', value: ticketUrl });
  if (host && host.name) pass.backFields.push({ key: 'host', label: 'Hosted by', value: host.name });
  pass.backFields.push({
    key: 'note', label: 'At the door',
    value: 'Show this pass to be scanned. It admits once. If anything goes wrong, the pass code above gets you in.'
  });

  // The SAME url the web pass encodes, so Wallet and browser scan identically.
  pass.setBarcodes({
    message: ticketUrl,
    format: 'PKBarcodeFormatQR',
    messageEncoding: 'iso-8859-1',
    altText: String(ticket.code)
  });

  return pass.getAsBuffer();
}

module.exports = { available, missing, buildTicketPass, ENV_KEYS };
