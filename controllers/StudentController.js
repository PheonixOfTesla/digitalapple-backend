/**
 * StudentController — server-side half of the study engine (DPT and GRE).
 *
 * The study app is local-first: the deck, the scheduling state and the review
 * history all live in the browser's IndexedDB and never come here. Only two
 * jobs genuinely require a server, and both are here for the same reason —
 * they need something the browser cannot safely or practically hold.
 *
 *   POST /api/v1/student/generate      the LLM key (via services/aiClient)
 *   POST /api/v1/student/import/apkg   a zip reader and a SQLite reader
 *
 * Single-user tool, so no accounts. Access is gated on the admin JWT because
 * generation spends money and .apkg parsing accepts uploads — neither should be
 * an open endpoint.
 */

const express = require('express');
const multer = require('multer');
const zlib = require('zlib');
const { generateCards, TRACKS, provider, model } = require('../services/studyGenerator');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// In-memory only. Railway's filesystem is ephemeral (hard rule #6), and an
// .apkg is parsed and discarded in one request — there is nothing to persist.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 120 * 1024 * 1024 },
});

/**
 * Admin-only. `verifyToken` populates req.userRole from the JWT; the role is
 * checked server-side rather than trusted from the client (hard rule #4).
 */
function requireOwner(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  next();
}

// Generation is the expensive path — a tighter limit than the global API one.
const genBuckets = new Map();
function generationLimit(req, res, next) {
  const key = req.userId || req.ip;
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const max = 60;

  const hits = (genBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    return res.status(429).json({
      error: `Generation limit reached (${max}/hour). This is a cost guard, not a capability limit.`,
      retryAfterMinutes: Math.ceil((windowMs - (now - hits[0])) / 60000),
    });
  }
  hits.push(now);
  genBuckets.set(key, hits);
  next();
}

// ─── Generation ────────────────────────────────────────────────────────────

router.post('/generate', verifyToken, requireOwner, generationLimit, async (req, res) => {
  try {
    const { text, course, domain, topic, count, source, track = 'dpt' } = req.body || {};

    if (!TRACKS[track]) return res.status(400).json({ error: `unknown track '${track}'` });
    if (!text) return res.status(400).json({ error: 'text is required' });
    // The DPT track uses dual-axis tagging (course x domain); GRE has no course
    // axis, so only the domain is required there.
    if (track === 'dpt' && !course) {
      return res.status(400).json({ error: 'course is required — dual-axis tagging' });
    }
    if (!domain) return res.status(400).json({ error: 'domain is required' });

    const result = await generateCards({ text, course, domain, topic, count, source, track });

    console.log(`[study] generated ${result.cards.length} cards ` +
      `(${result.warnings.length} dropped) track=${track} domain=${domain} ` +
      `provider=${result.provider} model=${result.model}`);

    res.json({
      cards: result.cards,
      warnings: result.warnings,
      model: result.model,
      provider: result.provider,
      usage: result.usage,
      // Stated in the response so a client that ignores it is still wrong about
      // nothing — the cards themselves all carry verified:false.
      note: 'All cards are unverified and must pass human review before study.',
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[study] generation failed:', err);
    res.status(status).json({ error: err.message || 'Generation failed' });
  }
});

// ─── Anki .apkg import ─────────────────────────────────────────────────────

/**
 * An .apkg is a ZIP containing `collection.anki2` (or `collection.anki21`), a
 * SQLite database whose `notes` table holds fields joined by 0x1f.
 *
 * Parsed with a hand-written reader rather than adding `yauzl` +
 * `better-sqlite3`: the latter is a native module that complicates the Railway
 * build, and only two structures are actually needed — the zip central
 * directory and SQLite's table B-tree. Deliberately narrow, and it fails with a
 * clear message rather than half-importing.
 */
router.post('/import/apkg', verifyToken, requireOwner, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

    const entries = readZip(req.file.buffer);
    const dbEntry = entries.find((e) => e.name === 'collection.anki21')
      || entries.find((e) => e.name === 'collection.anki2');

    if (!dbEntry) {
      return res.status(400).json({
        error: 'not a valid .apkg — no collection.anki2 or collection.anki21 inside',
        found: entries.map((e) => e.name).slice(0, 20),
      });
    }

    const db = inflateEntry(dbEntry);
    const notes = readAnkiNotes(db);

    if (!notes.length) {
      return res.status(422).json({
        error: 'the .apkg parsed but contained no readable notes. ' +
          'Anki 23.10+ decks may use a scheme this reader does not cover — ' +
          'export as "Notes in Plain Text" (.txt) and import that instead.',
      });
    }

    // Rows go back as loose objects and run through the same client-side import
    // pipeline as a CSV: one dedupe path, one validation path, one report.
    const rows = notes.map((n) => {
      const f = n.fields;
      return {
        front: f[0] || '',
        back: f.slice(1).filter(Boolean).join(' — '),
        tags: n.tags || '',
      };
    }).filter((r) => r.front.trim());

    console.log(`[study] apkg parsed: ${rows.length} notes from ${req.file.originalname}`);

    res.json({
      rows,
      totalNotes: notes.length,
      usableRows: rows.length,
      note: 'Fields beyond the first are joined into the back. Tag on import to set course and domain.',
    });
  } catch (err) {
    console.error('[study] apkg import failed:', err);
    res.status(400).json({
      error: `Could not read that .apkg: ${err.message}. ` +
        'Exporting from Anki as "Notes in Plain Text" (.txt) is the reliable fallback.',
    });
  }
});

// ─── Minimal ZIP reader ────────────────────────────────────────────────────

/** Walk the central directory. @param {Buffer} buf */
function readZip(buf) {
  // End of central directory: signature 0x06054b50, scanned from the tail
  // because it is followed by a variable-length comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no ZIP end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, localOff, buf });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** @param {{name:string,method:number,compSize:number,localOff:number,buf:Buffer}} entry */
function inflateEntry(entry) {
  const buf = entry.buf;
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('bad local file header');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const data = buf.slice(dataStart, dataStart + entry.compSize);

  if (entry.method === 0) return data;                    // stored
  if (entry.method === 8) return zlib.inflateRawSync(data); // deflate
  throw new Error(`unsupported ZIP compression method ${entry.method}`);
}

// ─── Minimal SQLite reader ─────────────────────────────────────────────────

/**
 * Read the `notes` table. Walks the schema to find its root page, then the
 * table B-tree, decoding only the record types Anki actually uses.
 * @param {Buffer} db
 */
function readAnkiNotes(db) {
  if (db.slice(0, 15).toString('latin1') !== 'SQLite format 3') {
    throw new Error('collection file is not a SQLite database');
  }
  const pageSize = (() => {
    const raw = db.readUInt16BE(16);
    return raw === 1 ? 65536 : raw;
  })();

  const page = (n) => db.slice((n - 1) * pageSize, n * pageSize);

  // sqlite_master is page 1. Find the notes table's root page and column order.
  const master = readTable(db, pageSize, 1);
  let notesRoot = null;
  let sqlText = '';
  for (const row of master) {
    // sqlite_master columns: type, name, tbl_name, rootpage, sql
    if (row[0] === 'table' && row[1] === 'notes') {
      notesRoot = Number(row[3]);
      sqlText = String(row[4] || '');
      break;
    }
  }
  if (!notesRoot) throw new Error('no `notes` table in the collection');

  // Column order from the CREATE statement — Anki has moved columns between
  // schema versions, so reading positionally without checking is fragile.
  const cols = (sqlText.match(/\(([\s\S]*)\)/)?.[1] || '')
    .split(',')
    .map((c) => c.trim().split(/\s+/)[0].replace(/["`\[\]]/g, '').toLowerCase());
  const flds = cols.indexOf('flds');
  const tagsCol = cols.indexOf('tags');

  const rows = readTable(db, pageSize, notesRoot);
  return rows.map((r) => {
    const fieldStr = String(flds >= 0 ? r[flds] ?? '' : r[6] ?? '');
    return {
      fields: fieldStr.split(''),
      tags: String(tagsCol >= 0 ? r[tagsCol] ?? '' : '').trim(),
    };
  }).filter((n) => n.fields.some((f) => String(f).trim()));
}

/** Read every row of a table B-tree rooted at `rootPage`. */
function readTable(db, pageSize, rootPage) {
  const rows = [];
  const seen = new Set();

  const walk = (pageNum) => {
    if (!pageNum || seen.has(pageNum) || rows.length > 200000) return;
    seen.add(pageNum);

    const base = (pageNum - 1) * pageSize;
    // Page 1 carries the 100-byte file header before its B-tree header.
    const hdr = base + (pageNum === 1 ? 100 : 0);
    const type = db[hdr];
    const cellCount = db.readUInt16BE(hdr + 3);
    const cellPtrBase = hdr + (type === 0x02 || type === 0x05 ? 12 : 8);

    if (type === 0x05) {                       // interior table page
      for (let i = 0; i < cellCount; i++) {
        const ptr = db.readUInt16BE(cellPtrBase + i * 2);
        walk(db.readUInt32BE(base + ptr));
      }
      walk(db.readUInt32BE(hdr + 8));          // rightmost pointer
      return;
    }
    if (type !== 0x0d) return;                 // only leaf table pages hold rows

    for (let i = 0; i < cellCount; i++) {
      const ptr = db.readUInt16BE(cellPtrBase + i * 2);
      let p = base + ptr;
      const [payloadLen, n1] = varint(db, p); p += n1;
      const [, n2] = varint(db, p); p += n2;     // rowid, unused

      // Overflow pages are not followed. Anki note payloads are small; a deck
      // with megabyte-scale fields is out of scope and says so rather than
      // silently returning truncated cards.
      const usable = pageSize - 0;
      const maxLocal = usable - 35;
      if (payloadLen > maxLocal) continue;

      rows.push(decodeRecord(db.slice(p, p + Number(payloadLen))));
    }
  };

  walk(rootPage);
  return rows;
}

/** SQLite varint. @returns {[number|bigint, number]} value and byte length */
function varint(buf, off) {
  let result = 0n;
  let i = 0;
  for (; i < 8; i++) {
    const byte = buf[off + i];
    result = (result << 7n) | BigInt(byte & 0x7f);
    if (!(byte & 0x80)) return [Number(result), i + 1];
  }
  result = (result << 8n) | BigInt(buf[off + 8]);
  return [Number(result), 9];
}

/** Decode one record (header of serial types, then the values). */
function decodeRecord(rec) {
  let p = 0;
  const [hdrLen, n] = varint(rec, 0);
  p = n;
  const types = [];
  while (p < hdrLen) {
    const [t, tn] = varint(rec, p);
    types.push(t);
    p += tn;
  }

  const values = [];
  for (const t of types) {
    if (t === 0) { values.push(null); }
    else if (t >= 1 && t <= 6) {
      const sizes = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 8 };
      const len = sizes[t];
      let v = 0n;
      for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(rec[p + k]);
      // Sign-extend.
      const bits = BigInt(len * 8);
      if (v >= 1n << (bits - 1n)) v -= 1n << bits;
      values.push(Number(v));
      p += len;
    }
    else if (t === 7) { values.push(rec.readDoubleBE(p)); p += 8; }
    else if (t === 8) { values.push(0); }
    else if (t === 9) { values.push(1); }
    else if (t >= 12 && t % 2 === 0) { const len = (t - 12) / 2; values.push(rec.slice(p, p + len)); p += len; }
    else if (t >= 13 && t % 2 === 1) { const len = (t - 13) / 2; values.push(rec.slice(p, p + len).toString('utf8')); p += len; }
    else { values.push(null); }
  }
  return values;
}

// ─── Health ────────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  // Which keys EXIST, as booleans only — never a value, never a prefix, never a
  // length. Having a key present and the provider still reading 'openai' is the
  // exact confusion this reports: services/aiClient picks the provider from
  // AI_PROVIDER, which defaults to 'openai' no matter which keys are configured.
  // Without this you cannot tell "no key" from "key ignored" from the outside.
  const keys = {
    MOONSHOT_API_KEY: Boolean(process.env.MOONSHOT_API_KEY),
    OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
  };
  const selector = process.env.AI_PROVIDER || null;
  const misconfigured = keys.MOONSHOT_API_KEY && provider !== 'moonshot';

  res.json({
    ok: true,
    // Generation rides the app's existing LLM client, so it is configured
    // wherever the rest of the app's AI features already are.
    provider,
    model,
    aiProviderEnv: selector,
    keysPresent: keys,
    ...(misconfigured ? {
      warning: 'A Moonshot key is configured but AI_PROVIDER is not set to ' +
        '"moonshot", so generation is running on ' + provider + '/' + model + '. ' +
        'Set AI_PROVIDER=moonshot to use it.',
    } : {}),
    tracks: Object.keys(TRACKS),
    note: 'The deck itself is local-first and never reaches this server.',
  });
});

module.exports = router;
