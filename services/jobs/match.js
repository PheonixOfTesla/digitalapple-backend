/**
 * You, against the corpus — twice.
 *
 * Two questions, deliberately answered separately, because they have different
 * answers and that IS the useful finding:
 *
 *   soonest   which kind of role could you get now? Smallest gap between what
 *             you have and what the postings ask for.
 *   highest   which kind of role pays most? Median of the bands actually
 *             stated in those postings.
 *
 * The gap between those two answers is the career decision. A tool that
 * collapses them into one "match score" hides exactly the thing worth seeing.
 *
 * Everything here is computed from the corpus, not from opinion: what a "Senior
 * Backend Engineer" requires is whatever those postings actually list, and what
 * it pays is whatever those postings actually say.
 */
const { groupOf } = require('./skills');

// Skills carry different weight. A language you do not have is a harder gap to
// close than a monitoring tool you would pick up in a week.
const GROUP_WEIGHT = { language: 3, backend: 2.5, frontend: 2.5, data: 2, infra: 1.5, practice: 1 };
const weightOf = skill => GROUP_WEIGHT[groupOf(skill)] || 1;

const LEVEL_ORDER = { junior: 0, mid: 1, senior: 2, staff: 3 };

/**
 * How close is this person to this one posting?
 *
 * Returns the score AND the reasoning, because "82%" on its own is not
 * something anybody can act on — the missing list is what tells you what to
 * learn, or that the posting is not worth your afternoon.
 */
function scorePosting(profile, posting) {
  const mine = new Set(profile.skillNames || []);
  const wanted = posting.skills || [];

  let have = 0, want = 0;
  const matched = [], missing = [];
  for (const s of wanted) {
    const w = weightOf(s);
    want += w;
    if (mine.has(s)) { have += w; matched.push(s); } else missing.push(s);
  }
  // A posting naming no known technology tells us nothing; treat it as neutral
  // rather than a perfect match, which is what dividing by zero would imply.
  const skillFit = want > 0 ? have / want : 0.5;

  // Seniority: being under-levelled is a real barrier, being over-levelled is
  // mostly not — nobody is rejected for having too much experience as often as
  // they are for having too little.
  const mineLvl = LEVEL_ORDER[profile.seniority] ?? 1;
  const theirs = LEVEL_ORDER[posting.seniority] ?? 1;
  const gap = theirs - mineLvl;
  const levelFit = gap <= 0 ? 1 : gap === 1 ? 0.6 : 0.25;

  // Years, when the posting says. Under by a year is nothing; under by five is
  // a different job.
  let yearsFit = 1;
  const askM = (posting.description || '').match(/(\d{1,2})\+?\s*(?:-|–|to)?\s*\d{0,2}\s*years?(?:\s+of)?\s+(?:experience|exp)/i);
  if (askM && profile.yearsExperience != null) {
    const asked = parseInt(askM[1], 10);
    const short = asked - profile.yearsExperience;
    yearsFit = short <= 0 ? 1 : short <= 1 ? 0.9 : short <= 3 ? 0.65 : 0.3;
  }

  const score = Math.round(100 * (skillFit * 0.6 + levelFit * 0.25 + yearsFit * 0.15));
  return {
    score,
    matched: matched.sort((a, b) => weightOf(b) - weightOf(a)),
    // Heaviest gaps first: that ordering is the study list.
    missing: missing.sort((a, b) => weightOf(b) - weightOf(a)),
    skillFit, levelFit, yearsFit
  };
}

/**
 * No rounding here. It used to round, which is harmless for salaries and
 * silently destroys a probability — a median hire rate of 0.034 came back as
 * 0, so every lane reported "0.0%" while its expected value was correct.
 * Round at the point of display, where you know what the number is.
 */
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The archetype table — the screen you actually make a decision on.
 *
 * One row per kind of job, each carrying both answers plus the evidence
 * underneath them, so "highest paid" is never a number with nothing behind it.
 */
function rankArchetypes(profile, postings, { minPostings = 5, odds = null } = {}) {
  const groups = new Map();
  for (const p of postings) {
    if (!p.isEngineering || !p.archetype) continue;
    if (!groups.has(p.archetype)) groups.set(p.archetype, []);
    groups.get(p.archetype).push(p);
  }

  const LEVEL_OF = { junior: 0, mid: 1, senior: 2, staff: 3 };
  const myLevel = LEVEL_OF[profile.seniority] ?? 1;

  const rows = [];
  for (const [archetype, jobs] of groups) {
    // A handful of postings is not a job market, it is noise with a name.
    if (jobs.length < minPostings) continue;

    const scored = jobs.map(j => ({ job: j, ...scorePosting(profile, j) }));
    const scores = scored.map(s => s.score).sort((a, b) => b - a);
    // The typical posting, not the best one: the top match in any group is an
    // outlier and ranking on it would recommend a lane on the strength of a
    // single lucky posting.
    const typical = median(scores);
    const strong = scored.filter(s => s.score >= 75).length;

    // Hire probability per lane, when the caller supplies the odds model.
    // Median rather than best: one lucky posting is not a lane.
    let hireMedian = null, evMedian = null;
    if (odds) {
      const hs = [], evs = [];
      for (const s of scored) {
        const o = odds(s.job, s);
        if (!o || o.blocked) continue;
        hs.push(o.hire);
        if (o.expectedValue != null) evs.push(o.expectedValue);
      }
      hireMedian = median(hs);
      evMedian = median(evs);
    }

    const pays = jobs.map(j => j.salary && j.salary.midAnnual).filter(Boolean);
    const payMedian = median(pays);
    const payTop = pays.length ? Math.max(...pays) : null;

    // What this lane asks for that you do not have, counted across the group.
    const gapCount = new Map();
    for (const s of scored) for (const m of s.missing) gapCount.set(m, (gapCount.get(m) || 0) + 1);
    const commonGaps = [...gapCount.entries()]
      .map(([skill, n]) => ({ skill, share: Math.round(n / jobs.length * 100), weight: weightOf(skill) }))
      .filter(g => g.share >= 25)
      .sort((a, b) => (b.share * b.weight) - (a.share * a.weight))
      .slice(0, 6);

    // Where this lane sits relative to YOU. Without this the "soonest" column
    // is a ranking of the easiest jobs in the corpus and nothing else: a lower
    // bar always produces a higher match, so an eleven-year engineer was being
    // shown Mid Frontend at the top and reading it as a recommendation.
    const laneLevel = LEVEL_OF[(jobs[0] && jobs[0].seniority) || 'mid'] ?? 1;
    const levelDelta = laneLevel - myLevel;

    rows.push({
      archetype,
      level: (jobs[0] && jobs[0].seniority) || 'mid',
      levelDelta,
      levelNote: levelDelta < 0 ? 'below your level' : levelDelta === 0 ? 'at your level'
               : levelDelta === 1 ? 'one step up' : 'two steps up',
      postings: jobs.length,
      remote: jobs.filter(j => j.remote).length,
      withSalary: pays.length,
      matchTypical: typical,
      strongMatches: strong,
      hireMedian,
      evMedian: evMedian == null ? null : Math.round(evMedian),
      appsPerOffer: hireMedian ? Math.ceil(1 / hireMedian) : null,
      payMedian, payTop,
      commonGaps,
      // The two rankings, before sorting, so the caller can present either.
      soonestScore: typical,
      // Pay only ranks a lane if enough of its postings state one. Ranking on
      // two disclosed salaries out of ninety is how you end up recommending a
      // lane on the strength of a rounding error.
      payRankable: pays.length >= Math.max(3, jobs.length * 0.15)
    });
  }

  // "Soonest" now means soonest WORTH TAKING. A lane below your level is not
  // an opportunity, it is a demotion that happens to score well, so it sorts
  // last rather than first. Still listed — a genuine fallback exists — but it
  // can no longer masquerade as the recommendation.
  const soonest = [...rows].sort((a, b) => {
    const aDown = a.levelDelta < 0, bDown = b.levelDelta < 0;
    if (aDown !== bDown) return aDown ? 1 : -1;
    return (b.soonestScore - a.soonestScore) || (b.strongMatches - a.strongMatches);
  });
  const highest = [...rows]
    .filter(r => r.payRankable)
    .sort((a, b) => (b.payMedian || 0) - (a.payMedian || 0));

  return { rows, soonest, highest };
}

/** The queue: individual postings in a chosen lane, best first. */
function rankPostings(profile, postings, { archetype = null, remoteOnly = false, minScore = 0, limit = 100 } = {}) {
  let pool = postings.filter(p => p.isEngineering);
  if (archetype) pool = pool.filter(p => p.archetype === archetype);
  if (remoteOnly) pool = pool.filter(p => p.remote);

  return pool
    .map(p => ({ job: p, ...scorePosting(profile, p) }))
    .filter(s => s.score >= minScore)
    .sort((a, b) => {
      // Score first, then pay, then freshness. A stale posting at the top of
      // the queue wastes the one thing an applicant cannot get back.
      if (b.score !== a.score) return b.score - a.score;
      const ap = (a.job.salary && a.job.salary.midAnnual) || 0;
      const bp = (b.job.salary && b.job.salary.midAnnual) || 0;
      if (bp !== ap) return bp - ap;
      return new Date(b.job.postedAt || 0) - new Date(a.job.postedAt || 0);
    })
    .slice(0, limit);
}

module.exports = { scorePosting, rankArchetypes, rankPostings, median, weightOf };
