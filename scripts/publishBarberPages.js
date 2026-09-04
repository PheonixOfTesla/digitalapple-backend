/**
 * Publish the barber pages to the marketing site.
 *
 * The backend serves /@handle and /book itself, but the copies people are
 * actually given live on the Vercel site, which is a different origin. That
 * difference is exactly one meta tag — the API host — so the copies are
 * GENERATED rather than maintained. Editing the marketing copy by hand is how
 * the two drift and how a fixed bug comes back.
 *
 * Usage:
 *   node scripts/publishBarberPages.js <target-dir> [--api https://api.host]
 *
 * Example:
 *   node scripts/publishBarberPages.js ../clockwork-landing-page
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_API = 'https://digitalapple-backend-production.up.railway.app';
const SRC = path.join(__dirname, '..', 'public', 'barber');

// book.html is the public page; index.html is the barber's panel. On the
// marketing site they are flat files, named for the routes that reach them.
const FILES = [
  { from: 'book.html', to: 'barber.html' },
  { from: 'index.html', to: 'barber-admin.html' }
];

function main() {
  const args = process.argv.slice(2);
  const target = args.find(a => !a.startsWith('--'));
  const apiIdx = args.indexOf('--api');
  const api = (apiIdx > -1 ? args[apiIdx + 1] : DEFAULT_API).replace(/\/+$/, '');

  if (!target) {
    console.error('Usage: node scripts/publishBarberPages.js <target-dir> [--api https://api.host]');
    process.exit(1);
  }
  if (!fs.existsSync(target)) {
    console.error('No such directory: ' + target);
    process.exit(1);
  }

  for (const f of FILES) {
    const src = fs.readFileSync(path.join(SRC, f.from), 'utf8');
    const out = src.replace('<meta name="barber-api" content="">',
                            `<meta name="barber-api" content="${api}">`);
    // A silent no-op here would publish a page that calls its own origin for an
    // API that is not there — a blank page with no error anyone can see.
    if (out === src) {
      console.error(`${f.from}: the barber-api meta tag is missing or already set — refusing to publish a page that would call the wrong host.`);
      process.exit(1);
    }
    fs.writeFileSync(path.join(target, f.to), out);
    console.log(`${f.from} → ${path.join(target, f.to)}  (api: ${api})`);
  }
  console.log('\nRoutes the site needs (vercel.json):');
  console.log('  /@:handle  → /barber');
  console.log('  /barber-admin is served by cleanUrls from barber-admin.html');
}

main();
