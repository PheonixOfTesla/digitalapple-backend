/**
 * Not "does this job match you" — "would you get it".
 *
 * A skill-overlap percentage is not a probability, and showing one where a
 * probability belongs is actively misleading: a 100% skill match on a famous
 * remote role that has been open six weeks is a worse use of an afternoon than
 * a 70% match posted yesterday at a company nobody has heard of. The match
 * score cannot tell you that. This is meant to.
 *
 * HONESTY ABOUT WHAT THIS IS. This is a model, not a measurement. It starts
 * from published cold-application base rates and moves them with factors we
 * can actually observe in the posting. Every factor is returned alongside the
 * number so it can be argued with, and the whole thing recalibrates against
 * YOUR real callback rate as soon as there is one — which is the actual payoff
 * of tracking responses, and the reason the Responses tab is not decoration.
 *
 * Base rates it starts from, stated plainly so they can be challenged:
 *   ~3%   cold application, no referral, average fit          (industry-wide)
 *   ~8%   strong fit, applied early
 *   ~15%  strong fit, early, and the resume parses cleanly
 * Anything above ~25% from a cold application is not credible and is capped.
 */

const BASE_RATE = 0.03;      // cold application, average fit, no referral
const MAX_COLD = 0.30;       // nothing cold is better than this; refuse to claim it

/** Requirements that are not negotiable, and that we can actually detect. */
const HARD_BLOCKERS = [
  { re: /\b(?:active\s+)?(?:ts\/sci|top secret|security clearance|polygraph)\b/i, label: 'security clearance' },
  { re: /\b(?:us|u\.s\.)\s+citizen(?:ship)?\s+(?:is\s+)?(?:required|only)\b|\bmust be a us citizen\b/i, label: 'US citizenship' },
  { re: /\bph\.?d\.?\s+(?:required|is required)\b|\brequires? a ph\.?d\b/i, label: 'PhD' },
  { re: /\b(?:must|required to)\s+(?:be\s+)?(?:onsite|on-site|in[\s-]office)\b|\b5 days? (?:a week )?in (?:the )?office\b/i, label: 'fully onsite' },
  { re: /\bactive\s+(?:pe|cpa|rn|md)\s+licen[sc]e\b/i, label: 'professional licence' }
];

function hardBlockers(description) {
  const d = String(description || '');
  return HARD_BLOCKERS.filter(b => b.re.test(d)).map(b => b.label);
}

/**
 * How long has this been open, and does that matter?
 *
 * It matters more than almost anything else people optimise. Postings
 * accumulate applicants fast and reviewers work through them in order, so the
 * same resume submitted on day 1 and on day 21 is not the same application.
 */
function freshnessFactor(postedAt) {
  if (!postedAt) return { factor: 0.8, days: null, note: 'no posting date — treated as middling' };
  const days = Math.max(0, (Date.now() - new Date(postedAt).getTime()) / 864e5);
  if (days <= 2) return { factor: 1.8, days, note: 'posted in the last 48 hours — the best window there is' };
  if (days <= 7) return { factor: 1.3, days, note: 'posted this week' };
  if (days <= 21) return { factor: 0.8, days, note: 'a few weeks old — the pile is deep by now' };
  if (days <= 45) return { factor: 0.45, days, note: 'over three weeks old — often already shortlisted' };
  return { factor: 0.2, days, note: 'stale — may be filled or a permanent listing' };
}

/**
 * How many other people are applying?
 *
 * We cannot see applicant counts, so this is a proxy built from what makes a
 * posting popular: remote reaches everyone, and a company with a large public
 * board is a company people have heard of. Both raise competition sharply.
 */
function competitionFactor(job, companySize) {
  let f = 1, notes = [];
  if (job.remote) { f *= 0.55; notes.push('remote — competes with everyone, not just a city'); }
  if (companySize >= 300) { f *= 0.6; notes.push('large, well-known employer — high applicant volume'); }
  else if (companySize >= 80) { f *= 0.8; notes.push('mid-size employer'); }
  else if (companySize > 0 && companySize < 15) { f *= 1.35; notes.push('small board — far fewer applicants'); }
  // Junior roles are swamped; staff roles are not.
  if (job.seniority === 'junior') { f *= 0.5; notes.push('junior roles draw the heaviest volume'); }
  if (job.seniority === 'staff') { f *= 1.25; notes.push('staff level — a much smaller applicant pool'); }
  return { factor: f, notes };
}

/**
 * Odds of hearing back on a cold application.
 *
 * `fit` is the output of scorePosting. `context` carries what we know beyond
 * the posting: the resume's ATS score, how big this employer's board is, and
 * the user's own observed callback rate once there is enough of one to trust.
 */
function offerOdds(profile, job, fit, context = {}) {
  const factors = [];
  const blockers = hardBlockers(job.description);

  // A hard blocker is not a low probability, it is a no. Saying "4%" about a
  // job that requires a clearance you do not have wastes the afternoon that
  // number was supposed to protect.
  if (blockers.length) {
    return {
      probability: 0, band: '0%', blocked: true, blockers,
      confidence: 'high',
      factors: [{ label: 'Hard requirement you do not meet: ' + blockers.join(', '), effect: 'blocks' }],
      summary: 'Requires ' + blockers.join(' and ') + '. Not worth the application.'
    };
  }

  // Start from the user's own rate if they have enough history; otherwise the
  // published cold rate. This is the number that gets better with use.
  const { observedRate, observedN } = context;
  const base = (observedN >= 15 && observedRate != null)
    ? Math.max(0.005, Math.min(0.35, observedRate))
    : BASE_RATE;
  const calibrated = observedN >= 15;
  if (calibrated) factors.push({ label: `Calibrated to your real callback rate (${Math.round(observedRate * 100)}% over ${observedN} applications)`, effect: 'base' });

  let p = base;

  // Skill fit, on a curve. Being at 90% is not three times better than 30% —
  // it is the difference between "screened in" and "screened out", and most of
  // the movement happens around the threshold.
  const sf = fit.skillFit;
  const skillMult = sf >= 0.85 ? 4.5 : sf >= 0.7 ? 3.0 : sf >= 0.55 ? 1.8 : sf >= 0.4 ? 1.0 : 0.45;
  p *= skillMult;
  factors.push({
    label: `Skill fit ${Math.round(sf * 100)}%` + (fit.missing.length ? ` — missing ${fit.missing.slice(0, 3).join(', ')}` : ' — nothing missing'),
    effect: skillMult >= 1.8 ? 'strong' : skillMult >= 1 ? 'neutral' : 'weak'
  });

  // Level and years. Being under-levelled is the most common silent rejection.
  p *= fit.levelFit;
  if (fit.levelFit < 1) factors.push({ label: `Posting is ${job.seniority}, you read as ${profile.seniority}`, effect: 'weak' });
  p *= fit.yearsFit;
  if (fit.yearsFit < 1) factors.push({ label: 'Fewer years than the posting asks for', effect: 'weak' });

  const fresh = freshnessFactor(job.postedAt);
  p *= fresh.factor;
  factors.push({ label: fresh.note, effect: fresh.factor >= 1.3 ? 'strong' : fresh.factor >= 0.8 ? 'neutral' : 'weak' });

  const comp = competitionFactor(job, context.companySize || 0);
  p *= comp.factor;
  comp.notes.forEach(n => factors.push({ label: n, effect: 'context' }));

  // The resume has to survive the parser before any of the above matters.
  const ats = context.atsScore;
  if (ats != null) {
    const atsMult = ats >= 90 ? 1.1 : ats >= 70 ? 1 : ats >= 40 ? 0.6 : 0.25;
    p *= atsMult;
    if (atsMult < 1) factors.push({ label: `Your resume scores ${ats} for ATS readability — fix that before anything else here`, effect: 'weak' });
  }

  p = Math.max(0.002, Math.min(MAX_COLD, p));

  // A point estimate implies precision this does not have. A band is honest.
  const lo = Math.max(0.001, p * 0.6), hi = Math.min(0.45, p * 1.6);
  const pct = n => (n * 100 < 1 ? (n * 100).toFixed(1) : Math.round(n * 100));

  return {
    probability: p,
    band: `${pct(lo)}–${pct(hi)}%`,
    blocked: false,
    blockers: [],
    // Without the user's own history this is a model built from published base
    // rates, and it should say so rather than implying it knows.
    confidence: calibrated ? 'calibrated to you' : 'modelled',
    factors,
    summary: p >= 0.12 ? 'Worth a tailored application today.'
      : p >= 0.05 ? 'Reasonable odds — apply if the role appeals.'
      : p >= 0.02 ? 'Long shot. Only with a strong, specific letter.'
      : 'Very long odds — better uses of the same hour.'
  };
}

/**
 * Your actual callback rate, for calibration.
 *
 * Only counts applications old enough to have been answered — counting last
 * week's applications as silent rejections would drag the rate down and make
 * every future estimate pessimistic.
 */
function observedCallbackRate(applications, { minAgeDays = 21 } = {}) {
  const cutoff = Date.now() - minAgeDays * 864e5;
  const settled = applications.filter(a => a.appliedAt && new Date(a.appliedAt).getTime() <= cutoff);
  if (!settled.length) return { observedRate: null, observedN: 0 };
  const heard = settled.filter(a => ['responded', 'interview', 'offer'].includes(a.status) ||
    (a.responses && a.responses.some(r => r.kind !== 'rejection'))).length;
  return { observedRate: heard / settled.length, observedN: settled.length };
}

/** Where a posting sits against what you actually want to earn. */
function versusTarget(job, targetBase) {
  if (!targetBase) return null;
  const s = job.salary;
  if (!s || !s.midAnnual) return { known: false, note: 'no salary stated' };
  const top = s.maxAnnual || s.midAnnual;
  const delta = s.midAnnual - targetBase;
  return {
    known: true,
    delta,
    // The top of the band is what you can negotiate toward; the midpoint is
    // what you should expect. Both matter and they say different things.
    meetsAtMid: s.midAnnual >= targetBase,
    meetsAtTop: top >= targetBase,
    note: s.midAnnual >= targetBase
      ? `${Math.round(delta / 1000)}k above target`
      : top >= targetBase
        ? `below target at the midpoint, reachable at the top of the band`
        : `${Math.round(-delta / 1000)}k below target`
  };
}


/**
 * Hire probability — the gauge, as opposed to the callback rate.
 *
 * These are different numbers and conflating them flatters you badly. A
 * callback is the odds somebody replies. Getting hired means surviving a
 * screen, an onsite loop and a hiring committee, and most people are
 * eliminated AFTER the callback, not before it.
 *
 *   P(hire) = P(callback) x P(offer | callback)
 *
 * The second factor sits around 12-15% for a typical candidate at a typical
 * company: a callback converts to a screen maybe 40% of the time, a screen to
 * an onsite loop, and a loop to an offer around 30%. Multiply it through and a
 * single cold application is a low-single-digit shot even when everything is
 * right. That is not pessimism, it is the arithmetic of funnels, and a tool
 * that shows 84% next to a job is lying about it.
 *
 * The point of the number is not to be discouraging. It is that P(hire) x
 * comp is the only figure that ranks two different jobs against each other —
 * a 2% shot at $300k is worth more than a 6% shot at $150k, and no match
 * percentage will ever tell you that.
 */

/** How a callback converts to an offer, given the shape of the fit. */
function conversionFactor(profile, job, fit) {
  let c = 0.14;                       // baseline offer-given-callback
  const notes = [];

  // Interviews test depth, and depth is where a thin skill match shows.
  if (fit.skillFit >= 0.85) { c *= 1.5; notes.push('deep skill overlap holds up in a technical loop'); }
  else if (fit.skillFit >= 0.7) { c *= 1.15; }
  else if (fit.skillFit < 0.5) { c *= 0.55; notes.push('thin overlap tends to surface in the technical rounds'); }

  // Being under-levelled costs far more at the loop than at the screen: the
  // bar is the level, not the resume.
  if (fit.levelFit < 1) { c *= fit.levelFit; notes.push('interviewing above your current level raises the bar you are measured against'); }
  if (fit.yearsFit < 0.7) { c *= 0.75; }

  // Longer loops, more committees, more ways to fall out.
  if (job.seniority === 'staff') { c *= 0.75; notes.push('staff loops are longer and add a committee'); }
  if (job.seniority === 'junior') { c *= 1.2; }

  // A company that publishes its range has usually decided what it is buying,
  // which converts better than one still working it out.
  if (job.salary && job.salary.midAnnual) { c *= 1.1; notes.push('published pay range — a decided role converts better'); }

  return { conversion: Math.max(0.02, Math.min(0.45, c)), notes };
}

/**
 * The gauge: odds this application ends in an offer, and what it is worth.
 *
 * `expectedValue` is P(hire) x the pay midpoint. It is the number that makes
 * two unlike jobs comparable, and the reason both ranking columns exist at
 * all can finally collapse into one.
 */
function hireOdds(profile, job, fit, context = {}) {
  const cb = offerOdds(profile, job, fit, context);
  if (cb.blocked) {
    return { ...cb, callback: 0, hire: 0, hireBand: '0%', conversion: 0,
             expectedValue: 0, funnel: [], gauge: 'blocked' };
  }

  const { conversion, notes } = conversionFactor(profile, job, fit);
  const hire = cb.probability * conversion;
  const pay = (job.salary && job.salary.midAnnual) || null;

  const pct = n => (n * 100 < 1 ? (n * 100).toFixed(1) : (n * 100).toFixed(n * 100 < 10 ? 1 : 0));
  const lo = hire * 0.55, hi = hire * 1.7;

  return {
    ...cb,
    callback: cb.probability,
    conversion,
    hire,
    hireBand: `${pct(lo)}–${pct(hi)}%`,
    // Shown as a funnel because one number hides where you actually lose.
    funnel: [
      { stage: 'They reply', p: cb.probability },
      { stage: 'You get an offer', p: hire }
    ],
    expectedValue: pay ? Math.round(hire * pay) : null,
    // The most usable form of the gauge. "3.4%" is abstract; "about 30
    // applications for one offer" is a plan you can hold a week against.
    appsPerOffer: hire > 0 ? Math.ceil(1 / hire) : null,
    conversionNotes: notes,
    gauge: hire >= 0.02 ? 'strong' : hire >= 0.008 ? 'fair' : 'long',
    hireSummary: hire >= 0.02
      ? 'A genuinely good shot for a cold application.'
      : hire >= 0.008
        ? 'Normal odds — this is what a real pipeline is made of.'
        : 'Long. Worth it only if you want this one specifically.'
  };
}

/**
 * Your real offer rate, once there is one — the same idea as the callback
 * calibration, one stage further down the funnel.
 */
function observedOfferRate(applications, { minAgeDays = 45 } = {}) {
  const cutoff = Date.now() - minAgeDays * 864e5;
  const settled = applications.filter(a => a.appliedAt && new Date(a.appliedAt).getTime() <= cutoff);
  if (settled.length < 10) return { offerRate: null, offerN: settled.length };
  const offers = settled.filter(a => a.status === 'offer').length;
  return { offerRate: offers / settled.length, offerN: settled.length };
}


/**
 * The question underneath all the others: will I get hired?
 *
 * Per-application odds are demoralising and also not the thing you want to
 * know. Nobody applies once. Across N independent applications the chance of
 * at least one offer is 1 - (1 - p)^N, and that turns 3% a shot into something
 * you can plan a month around.
 *
 * WHERE THIS OVERSTATES. The applications are not fully independent. If the
 * resume has a systematic flaw — parses badly, misses the keywords everyone
 * screens on, claims a level the evidence does not support — then every
 * application fails for the same reason and volume does not rescue it. That
 * is exactly why the ATS readability score gates the whole model, and why
 * this returns a correlation-adjusted figure alongside the naive one rather
 * than quietly reporting the flattering number.
 */
function campaignOdds(perApp, n, { correlation = 0.25 } = {}) {
  const p = Math.max(0, Math.min(1, perApp || 0));
  if (!p || !n) return { naive: 0, adjusted: 0, n: n || 0 };
  const naive = 1 - Math.pow(1 - p, n);
  // Correlated failure modes mean the effective number of independent shots is
  // lower than the number of applications sent.
  const effective = n * (1 - correlation);
  const adjusted = 1 - Math.pow(1 - p, effective);
  return { naive, adjusted, n, effectiveN: Math.round(effective) };
}

/** How many applications to reach a target confidence of at least one offer. */
function applicationsFor(perApp, target = 0.8, { correlation = 0.25 } = {}) {
  const p = Math.max(1e-6, Math.min(0.999, perApp || 0));
  const n = Math.log(1 - target) / Math.log(1 - p);
  return Math.ceil(n / (1 - correlation));
}

module.exports = { offerOdds, hireOdds, campaignOdds, applicationsFor, conversionFactor, observedOfferRate, observedCallbackRate, versusTarget, hardBlockers, freshnessFactor, BASE_RATE, MAX_COLD };
