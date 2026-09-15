/**
 * Connect — share your Hub identity like a pass.
 *
 * The insight: people already paste their Hub link into Instagram bios and swap
 * it in person. This turns that link into something you SHARE with a gesture — a
 * QR anyone can scan today, and an Apple Wallet pass you keep in Wallet and show
 * or tap. One identity (`/@handle`), several ways to hand it over.
 *
 * A NOTE ON "DOUBLE-TAP TWO iPHONES". True silent iPhone-to-iPhone data exchange
 * is not an API Apple gives third parties — NameDrop and AirDrop are Apple's own,
 * and the old NFC "bump" was retired. What DOES work, and is what the big digital
 * card companies actually ship: an NFC tag/sticker encoded with your URL (tap to
 * open), an Apple Wallet pass (tap/scan its code), and a QR (scan). This
 * controller serves the QR and the Wallet pass; the NFC tag is encoded with the
 * same `/@handle` URL these produce, so all three point at one identity.
 */

const express = require('express');
const QRCode = require('qrcode');
const User = require('../models/User');
const { siteUrl } = require('../services/siteUrl');

const router = express.Router();

/** Resolve a public profile by handle. Public — a Hub identity is meant to be found. */
async function findByHandle(raw) {
  const handle = String(raw || '').replace(/^@/, '').toLowerCase().trim();
  if (!handle) return null;
  return User.findOne({ handle }).select('firstName lastName handle about profilePhoto profilePhotoThumb verified').lean();
}

const nameOf = (u) => ([u.firstName, u.lastName].filter(Boolean).join(' ').trim())
  || (u.handle ? '@' + u.handle : 'Member');

/** The canonical shareable URL for a person — what every QR, tag and pass points at. */
const profileUrl = (handle) => `${siteUrl()}/@${handle}`;

// ── QR — works on every phone today, no account, no app ──────────────────────

// GET /connect/:handle/qr.png  — a scannable code for that person's Hub.
// PNG so it drops straight into an <img>, a story, a printed card, a phone lock
// screen. Cached hard: a person's profile URL does not change.
router.get('/:handle/qr.png', async (req, res) => {
  try {
    const u = await findByHandle(req.params.handle);
    if (!u) return res.status(404).json({ error: 'No Hub for that handle' });
    const size = Math.min(1024, Math.max(128, parseInt(req.query.size, 10) || 512));
    const png = await QRCode.toBuffer(profileUrl(u.handle), {
      type: 'png', width: size, margin: 1,
      // Hub palette: near-black on off-white, so it reads and stays on-brand.
      color: { dark: '#0A0A0FFF', light: '#F0F4F8FF' },
      errorCorrectionLevel: 'M'
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(png);
  } catch (e) {
    console.error('[connect] qr error:', e.message);
    res.status(500).json({ error: 'Could not make QR' });
  }
});

// GET /connect/:handle/card — the data a native "Connect" sheet renders, and the
// share text for AirDrop/Messages. Small JSON, public-safe fields only.
router.get('/:handle/card', async (req, res) => {
  try {
    const u = await findByHandle(req.params.handle);
    if (!u) return res.status(404).json({ error: 'No Hub for that handle' });
    res.json({
      success: true,
      name: nameOf(u),
      handle: u.handle,
      about: (u.about || '').slice(0, 200),
      photo: u.profilePhoto || u.profilePhotoThumb || null,
      verified: !!u.verified,
      url: profileUrl(u.handle),
      qr: `${siteUrl()}/api/v1/connect/${u.handle}/qr.png`
    });
  } catch (e) {
    console.error('[connect] card error:', e.message);
    res.status(500).json({ error: 'Could not load card' });
  }
});

// ── Apple Wallet pass ────────────────────────────────────────────────────────

// Whether Wallet passes can be issued. Signing needs a Pass Type ID certificate
// from the Apple Developer account; until those env vars are set this reports
// false and the pass route returns a clear 501 rather than a broken download.
function passConfigured() {
  return !!(process.env.PASS_CERT_PEM && process.env.PASS_KEY_PEM
    && process.env.PASS_WWDR_PEM && process.env.PASS_TYPE_ID && process.env.PASS_TEAM_ID);
}

router.get('/pass/status', (req, res) => {
  res.json({ success: true, configured: passConfigured() });
});

// GET /connect/:handle/pass.pkpass — add-to-Apple-Wallet identity card.
router.get('/:handle/pass.pkpass', async (req, res) => {
  if (!passConfigured()) {
    // Honest failure: the code is ready, the credential is not. Names exactly
    // what the Apple Developer account must supply, so wiring it later is a
    // matter of setting env vars, not writing more code.
    return res.status(501).json({
      error: 'Wallet passes not configured',
      needs: ['PASS_CERT_PEM', 'PASS_KEY_PEM', 'PASS_WWDR_PEM', 'PASS_TYPE_ID', 'PASS_TEAM_ID', '+ icon.png/logo.png assets']
    });
  }
  try {
    const u = await findByHandle(req.params.handle);
    if (!u) return res.status(404).json({ error: 'No Hub for that handle' });

    const { PKPass } = require('passkit-generator');
    const pass = new PKPass({}, {
      wwdr: process.env.PASS_WWDR_PEM,
      signerCert: process.env.PASS_CERT_PEM,
      signerKey: process.env.PASS_KEY_PEM
    }, {
      passTypeIdentifier: process.env.PASS_TYPE_ID,
      teamIdentifier: process.env.PASS_TEAM_ID,
      organizationName: 'Clockwork Hub',
      description: `${nameOf(u)} — Clockwork Hub`,
      foregroundColor: 'rgb(240,244,248)',
      backgroundColor: 'rgb(10,10,15)',
      labelColor: 'rgb(0,229,255)'
    });
    pass.type = 'generic';
    pass.primaryFields.push({ key: 'name', label: 'CLOCKWORK HUB', value: nameOf(u) });
    pass.secondaryFields.push({ key: 'handle', label: 'CONNECT', value: '@' + u.handle });
    // The barcode IS the share: scanning it opens the person's Hub.
    pass.setBarcodes({ message: profileUrl(u.handle), format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1' });

    const buf = pass.getAsBuffer();
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Content-Disposition', `attachment; filename="${u.handle}.pkpass"`);
    res.send(buf);
  } catch (e) {
    console.error('[connect] pass error:', e.message);
    res.status(500).json({ error: 'Could not build pass' });
  }
});

module.exports = router;
