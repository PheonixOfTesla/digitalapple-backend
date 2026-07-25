/**
 * reelRender — one-click reel → MP4 worker.
 *
 * Ported from the offline pipeline (reel-make.cjs):
 *   1) optional VO via the stored ElevenLabs key (with-timestamps)
 *   2) derive scene cues from the anchor words → template `t` config
 *   3) drive the DEPLOYED nebula-reel.html template in headless Chromium
 *      (full-bleed 540x960 scaled 2x → 1080x1920), record, grade with ffmpeg
 *   4) upload to Cloudinary (video), save a LabAsset, record TTS cost
 *
 * Jobs run one at a time in-process; state lives in an in-memory map
 * (poll /admin/lab/reel-render-status). Chromium + ffmpeg come from the
 * nixpacks build (see nixpacks.toml); on hosts without them the enqueue
 * fails fast with a clear error instead of crashing the app.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');

const TEMPLATE_BASE = process.env.REEL_TEMPLATE_BASE || 'https://www.theclockworkhub.com/ads/nebula-reel.html';
const LEADIN = 0.5;

const jobs = new Map();            // id -> { status, step, error, asset, createdAt }
let chain = Promise.resolve();     // serialize renders (one Chromium at a time)
let cleaned = false;

// Persist job state so an OOM/restart mid-render reports "failed" instead of
// the job map vanishing into 404s. Best-effort: DB writes never break a render.
function persist(job) {
  try {
    const RenderJob = require('../models/RenderJob');
    RenderJob.updateOne({ jobId: job.id },
      { $set: { status: job.status, step: job.step, error: job.error, asset: job.asset } },
      { upsert: true }).exec().catch(() => {});
  } catch (e) {}
}
async function bootCleanup() {
  if (cleaned) return; cleaned = true;
  try {
    const RenderJob = require('../models/RenderJob');
    await RenderJob.updateMany(
      { status: { $in: ['queued', 'running'] } },
      { $set: { status: 'failed', step: 'lost', error: 'Server restarted mid-render (likely out of memory) — try again' } });
  } catch (e) {}
}

function which(bin) {
  try { return execSync(`which ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; }
  catch (e) { return null; }
}
function findChromium() {
  return process.env.CHROMIUM_PATH || which('chromium') || which('chromium-browser') ||
    ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p)) || null;
}
function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const sys = which('ffmpeg'); if (sys) return sys;
  try { return require('ffmpeg-static'); } catch (e) { return null; }
}

function b64(obj) { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); }

// ---- VO: stored key -> audio + anchor-derived cue table -------------------
async function makeVoice(spec, tmp) {
  const Setting = require('../models/Setting');
  const [el, v] = await Promise.all([
    Setting.findOne({ key: 'elevenlabs_api_key' }),
    Setting.findOne({ key: 'elevenlabs_voice_id' })
  ]);
  const key = el && el.value, voiceId = v && v.value;
  const vo = spec.vo;
  if (!key || !voiceId || !vo || !vo.text) return null;

  const TEXT = String(vo.text);
  const ANCH = vo.anchors || {};
  const need = ['hook', 'reveal', 'gap', 'zoom', 'summary', 'plan', 'cta'];
  if (!need.every(k => ANCH[k] && TEXT.indexOf(ANCH[k]) >= 0)) return null;  // anchors must be real substrings

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: TEXT, model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true } })
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  const raw = path.join(tmp, 'vo-raw.mp3');
  fs.writeFileSync(raw, Buffer.from(j.audio_base64, 'base64'));
  const cs = j.alignment.character_start_times_seconds;
  const at = sub => cs[TEXT.indexOf(sub)] + LEADIN;

  const A = { hook: at(ANCH.hook), reveal: at(ANCH.reveal), gap: at(ANCH.gap),
              zoom: at(ANCH.zoom), summary: at(ANCH.summary), plan: at(ANCH.plan), cta: at(ANCH.cta) };
  const audioEnd = cs[cs.length - 1] + LEADIN + 0.3;
  const T = +(audioEnd + 0.5).toFixed(2);
  const n = (spec.nodes || []).length || 6;
  const f2 = x => +x.toFixed(2);
  const formStart = f2(A.hook + 0.5);
  const formStep = +Math.min(0.4, Math.max(0.18, (A.reveal - 0.5 - formStart) / n)).toFixed(3);
  const timing = {
    T,
    cues: {
      brand: [0.5, f2(T - 0.5)],
      bHook: [f2(A.hook - 0.35), f2(A.reveal - 0.2)],
      bReveal: [f2(A.reveal - 0.3), f2(A.gap - 0.2)],
      bGap: [f2(A.gap - 0.3), f2(A.zoom - 0.2)],
      bZoom: [f2(A.zoom - 0.3), f2(A.summary - 0.5)],
      bSummary: [f2(A.summary - 0.05), f2(A.plan - 0.4)],
      rexport: [f2(A.summary + 0.7), f2(A.plan - 0.15)],
      bPlan: [f2(A.plan - 0.25), f2(A.cta - 0.2)],
      cta: [f2(A.cta - 0.25), T]
    },
    form: { start: formStart, step: formStep }
  };

  // final VO track: lead-in, loudness-normalized, padded to T
  const FF = findFfmpeg();
  const mix = path.join(tmp, 'vo.mp3');
  execFileSync(FF, ['-y', '-i', raw, '-af',
    `adelay=${Math.round(LEADIN * 1000)}:all=1,loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=0:${T}`,
    '-ar', '48000', '-ac', '2', mix], { stdio: 'ignore' });

  // record the real TTS spend (same policy as /lab/tts)
  let costUsd = 0;
  try {
    const perK = parseFloat(process.env.ELEVENLABS_PRICE_PER_1K_CHARS);
    const rate = Number.isFinite(perK) ? perK : 0.22;
    costUsd = +((TEXT.length / 1000) * rate).toFixed(4);
    if (costUsd > 0) {
      const AiCredit = require('../models/AiCredit');
      let doc = await AiCredit.findOne({ key: 'global' });
      if (!doc) doc = await AiCredit.create({ key: 'global' });
      doc.labCostUsd = +((doc.labCostUsd || 0) + costUsd).toFixed(4);
      doc.history.push({ type: 'load', amount: -costUsd, note: `Reel render VO · ${TEXT.length} chars`, balanceAfter: null });
      await doc.save();
    }
  } catch (e) { console.error('[reelRender] cost record failed:', e.message); }

  return { mix, timing, T, costUsd };
}

// ---- the render itself ----------------------------------------------------
async function renderJob(job, spec) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  try {
    const CHROME = findChromium();
    const FF = findFfmpeg();
    if (!CHROME) throw new Error('Chromium not available on this host');
    if (!FF) throw new Error('ffmpeg not available on this host');

    // 1) voice (optional — silent render if no key/voice/anchors)
    job.step = 'voice'; persist(job);
    let voice = null;
    try { voice = await makeVoice(spec, tmp); }
    catch (e) { console.error('[reelRender] VO failed, rendering silent:', e.message); }
    const T = voice ? voice.timing.T : 16.6;
    const cfg = voice ? Object.assign({}, spec, { t: voice.timing }) : spec;

    // 2) record the deployed template
    job.step = 'record'; persist(job);
    const { chromium } = require('playwright-core');
    // dsf 1 keeps the raster at exactly 1080x1920 — dsf 2 (supersampling)
    // quadruples memory and OOM-killed the container on Railway.
    const DSF = Math.max(1, parseInt(process.env.RENDER_DSF || '1', 10) || 1);
    const browser = await chromium.launch({
      executablePath: CHROME,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader',
        '--disable-gpu-compositing', '--disable-extensions', '--mute-audio', '--hide-scrollbars',
        '--autoplay-policy=no-user-gesture-required']
    });
    let webm;
    try {
      const ctx = await browser.newContext({
        viewport: { width: 1080, height: 1920 }, deviceScaleFactor: DSF,
        recordVideo: { dir: tmp, size: { width: 1080, height: 1920 } }
      });
      const page = await ctx.newPage();
      const t0 = Date.now();
      await page.goto(`${TEMPLATE_BASE}?data=${encodeURIComponent(b64(cfg))}`, { waitUntil: 'load', timeout: 45000 });
      await page.addStyleTag({ content: `
        html,body{padding:0!important;margin:0!important;background:#05060a!important;overflow:hidden!important}
        .caption{display:none!important}
        .stage{position:fixed!important;top:0!important;left:0!important;width:540px!important;height:960px!important;
          max-width:none!important;border-radius:0!important;transform:scale(2)!important;transform-origin:top left!important;box-shadow:none!important}` });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await page.waitForTimeout(400);
      await page.evaluate(() => window.__reset && window.__reset());
      const trim = (Date.now() - t0) / 1000;
      await page.waitForTimeout(T * 1000 + 300);
      const video = page.video();
      await ctx.close();
      webm = await video.path();
      job.trim = trim;
    } finally { await browser.close().catch(() => {}); }

    // 3) grade + mux
    job.step = 'encode'; persist(job);
    const out = path.join(tmp, 'reel.mp4');
    const VF = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,' +
               'eq=gamma=1.12:brightness=0.015:saturation=1.16:contrast=1.05,format=yuv420p';
    const VBASE = ['-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2', '-preset', 'fast', '-crf', '18',
      '-maxrate', '10M', '-bufsize', '14M', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709',
      '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-movflags', '+faststart',
      '-threads', '2'];
    const args = ['-y', '-ss', String(job.trim || 0), '-i', webm];
    if (voice) args.push('-i', voice.mix);
    args.push('-vf', VF, ...VBASE);
    if (voice) args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-map', '0:v:0', '-map', '1:a:0');
    else args.push('-an');
    args.push('-t', String(T), out);
    execFileSync(FF, args, { stdio: 'ignore' });

    // 4) upload + persist
    job.step = 'upload'; persist(job);
    const cloudinary = require('cloudinary').v2;
    const slug = String(spec.topic || spec.hook || 'reel').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '') || 'reel';
    const up = await cloudinary.uploader.upload(out, {
      resource_type: 'video', folder: 'digitalapple/reels',
      public_id: `${slug}-${Date.now()}`, overwrite: false
    });

    const LabAsset = require('../models/LabAsset');
    const asset = await LabAsset.create({
      name: `${spec.title || spec.topic || spec.hook || 'Reel'}${voice ? ' — voiced' : ' — silent'}`,
      kind: 'reel', url: up.secure_url, publicId: up.public_id,
      bytes: up.bytes || fs.statSync(out).size, duration: T,
      voiced: !!voice, topic: spec.topic || '', spec,
      costUsd: voice ? voice.costUsd : 0
    });

    job.status = 'done';
    job.step = 'done';
    job.asset = { id: asset._id, name: asset.name, url: asset.url, voiced: asset.voiced, duration: T, bytes: asset.bytes };
    persist(job);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- public API -----------------------------------------------------------
function enqueue(spec) {
  const CHROME = findChromium(), FF = findFfmpeg();
  if (!CHROME || !FF) {
    throw new Error('Render engine not available on this deployment (chromium/ffmpeg missing)');
  }
  bootCleanup();
  const pending = [...jobs.values()].filter(j => j.status === 'queued' || j.status === 'running').length;
  if (pending >= 2) throw new Error('Two renders are already in flight — wait for them to finish');
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, status: 'queued', step: 'queued', error: null, asset: null, createdAt: Date.now() };
  jobs.set(id, job);
  persist(job);
  chain = chain.then(async () => {
    job.status = 'running'; persist(job);
    try { await renderJob(job, spec); }
    catch (e) {
      console.error('[reelRender] job failed:', e.message);
      job.status = 'failed'; job.error = e.message; persist(job);
    }
  });
  // keep the map small
  for (const [k, v] of jobs) if (Date.now() - v.createdAt > 3600e3) jobs.delete(k);
  return id;
}
async function status(id) {
  await bootCleanup();
  if (jobs.has(id)) return jobs.get(id);
  try {
    const RenderJob = require('../models/RenderJob');
    const doc = await RenderJob.findOne({ jobId: id }).lean();
    if (doc) return { id, status: doc.status, step: doc.step, error: doc.error, asset: doc.asset };
  } catch (e) {}
  return null;
}
function engineAvailable() { return !!(findChromium() && findFfmpeg()); }

module.exports = { enqueue, status, engineAvailable, bootCleanup };
