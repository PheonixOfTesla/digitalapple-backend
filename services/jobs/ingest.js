/**
 * Pull every source, work out what each posting IS, and store one row per real
 * job rather than one per sighting.
 *
 * Roughly 15,400 postings arrive per pass across 146 company boards and 9
 * global boards, with heavy duplication — the aggregators are largely reading
 * the same ATSes we are. Everything expensive (salary parsing, skill
 * extraction, classification) happens once here, at write time, because the
 * matcher scans the whole corpus on every request and re-deriving all of it
 * per read is the obvious way to make the console feel broken.
 */
const JobPosting = require('../../models/JobPosting');
const { SOURCES } = require('./sources');
const { atsTargets } = require('./companies');
const { extractSalary } = require('./salary');
const { skillsInText } = require('./skills');

// What counts as a software engineering role. Generous on the role, strict on
// the exclusions — the failure to avoid is a queue full of "Sales Engineer"
// and "Engineering Manager", which are neither of them this job.
const ROLE = /\b(software|full[\s-]?stack|fullstack|back[\s-]?end|backend|front[\s-]?end|frontend|web|platform|application|product|mobile)\s+(engineer|developer)\b|\b(swe|sde)\b|\bengineer,\s*(software|full|back|front|platform|web)\b|\bsoftware development engineer\b/i;
const NOT_ROLE = /\b(sales|solutions?|customer|support|field|forward[\s-]?deployed|hardware|mechanical|electrical|civil|chemical|recruiter|manager|director|head of|vp\b|intern)\b/i;

function seniorityOf(title) {
  const t = String(title || '');
  if (/\b(staff|principal|distinguished|architect)\b/i.test(t)) return 'staff';
  if (/\b(senior|sr\.?|lead|iii|iv|l[5-7])\b/i.test(t)) return 'senior';
  if (/\b(junior|jr\.?|entry|graduate|new grad|associate|i{1,2}\b)\b/i.test(t)) return 'junior';
  return 'mid';
}

/**
 * The role archetype — the shape of the job, not its title.
 *
 * This is what the two rankings are computed over: you do not choose between
 * 15,000 postings, you choose between about a dozen kinds of job, and then the
 * queue narrows to the one you picked.
 */
function archetypeOf(title, skills, seniority) {
  const t = String(title || '').toLowerCase();
  const has = s => skills.includes(s);
  let discipline = 'Full-Stack';
  if (/front[\s-]?end/.test(t) || (has('react') && !has('node') && !has('python'))) discipline = 'Frontend';
  else if (/back[\s-]?end|api|infrastructure|platform/.test(t)) discipline = 'Backend';
  else if (/full[\s-]?stack/.test(t)) discipline = 'Full-Stack';
  else if (/mobile|ios|android/.test(t)) discipline = 'Mobile';
  else if (has('react') && (has('node') || has('python') || has('postgres'))) discipline = 'Full-Stack';
  else if (has('node') || has('django') || has('rails') || has('spring')) discipline = 'Backend';

  const level = { junior: 'Junior', mid: 'Mid', senior: 'Senior', staff: 'Staff' }[seniority] || 'Mid';
  return `${level} ${discipline} Engineer`;
}

/** Fetch everything. Each source swallows its own failures. */
async function fetchAll({ onProgress } = {}) {
  const items = [];
  const report = { sources: [], errors: [] };

  for (const s of SOURCES.filter(x => !x.perCompany)) {
    try {
      const r = await s.fetchAll();
      items.push(...r.items);
      report.sources.push({ name: s.name, kind: 'board', count: r.items.length, ok: r.ok });
      if (!r.ok) report.errors.push({ source: s.name, error: r.error });
    } catch (e) {
      report.sources.push({ name: s.name, kind: 'board', count: 0, ok: false });
      report.errors.push({ source: s.name, error: e.message });
    }
    if (onProgress) onProgress(items.length);
  }

  // ATS boards run in batches: 146 sequential round trips is minutes of
  // waiting for no reason, and 146 at once is a good way to get rate limited.
  const targets = atsTargets();
  const BATCH = 12;
  for (let i = 0; i < targets.length; i += BATCH) {
    await Promise.all(targets.slice(i, i + BATCH).map(async ({ vendor, slug }) => {
      const s = SOURCES.find(x => x.name === vendor);
      if (!s) return;
      try {
        const r = await s.fetchFor(slug);
        items.push(...r.items);
        if (!r.items.length) report.errors.push({ source: `${vendor}/${slug}`, error: r.error || 'empty' });
      } catch (e) {
        report.errors.push({ source: `${vendor}/${slug}`, error: e.message });
      }
    }));
    if (onProgress) onProgress(items.length);
  }
  report.fetched = items.length;
  return { items, report };
}

/** Everything derived, computed once. */
function enrich(p) {
  const isEng = ROLE.test(p.title) && !NOT_ROLE.test(p.title);
  const skills = skillsInText(p.title + ' ' + (p.description || ''));
  const seniority = seniorityOf(p.title);
  const salary = extractSalary(p.salaryText, p.description);
  return {
    ...p,
    isEngineering: isEng,
    skills,
    seniority,
    salary: salary || undefined,
    archetype: isEng ? archetypeOf(p.title, skills, seniority) : null
  };
}

/**
 * Collapse sightings into jobs.
 *
 * When the same role arrives from several places, the ATS copy wins: it links
 * to a form we can fill, where a board's copy is a redirect to somebody else's
 * site. Same job, very different value — and picking the wrong one silently
 * turns an applyable role into a dead end.
 */
function dedupe(items) {
  const byPrint = new Map();
  for (const raw of items) {
    if (!raw || !raw.title) continue;
    const fp = JobPosting.fingerprintOf(raw.company, raw.title);
    if (!fp || fp === '|') continue;
    const prev = byPrint.get(fp);
    const sighting = { source: raw.source, url: raw.url, at: new Date() };
    if (!prev) {
      byPrint.set(fp, { ...raw, fingerprint: fp, seenIn: [sighting] });
      continue;
    }
    prev.seenIn.push(sighting);
    const better =
      (raw.sourceKind === 'ats' && prev.sourceKind !== 'ats') ||
      // Between two of the same kind, prefer the one that actually describes
      // the job — a longer description is more to match and tailor against.
      (raw.sourceKind === prev.sourceKind &&
        (raw.description || '').length > (prev.description || '').length * 1.3);
    if (better) {
      const seen = prev.seenIn;
      byPrint.set(fp, { ...raw, fingerprint: fp, seenIn: seen });
    }
  }
  return [...byPrint.values()];
}

/** Fetch → enrich → dedupe → upsert. Returns a report worth showing a human. */
async function runIngest({ engineeringOnly = false } = {}) {
  const startedAt = new Date();
  const { items, report } = await fetchAll();

  const enriched = items.map(enrich);
  const kept = engineeringOnly ? enriched.filter(p => p.isEngineering) : enriched;
  const unique = dedupe(kept);

  let created = 0, updated = 0;
  const BATCH = 200;
  for (let i = 0; i < unique.length; i += BATCH) {
    await Promise.all(unique.slice(i, i + BATCH).map(async p => {
      const { salaryText, ...doc } = p;
      const r = await JobPosting.updateOne(
        { fingerprint: p.fingerprint },
        {
          $set: { ...doc, lastSeenAt: new Date(), closed: false },
          $setOnInsert: { firstSeenAt: new Date() }
        },
        { upsert: true }
      );
      if (r.upsertedCount) created++; else if (r.modifiedCount) updated++;
    }));
  }

  const engineering = unique.filter(p => p.isEngineering).length;
  const withSalary = unique.filter(p => p.salary).length;
  return {
    startedAt, finishedAt: new Date(),
    fetched: report.fetched,
    unique: unique.length,
    duplicatesCollapsed: kept.length - unique.length,
    engineering, withSalary,
    created, updated,
    sources: report.sources,
    errors: report.errors.slice(0, 40)
  };
}

module.exports = { runIngest, fetchAll, enrich, dedupe, archetypeOf, seniorityOf, ROLE, NOT_ROLE };
