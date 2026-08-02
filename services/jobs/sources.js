/**
 * Every job source, in one place, behind one shape.
 *
 * The rule here: NOTHING is in this file that was not fetched successfully
 * first. Every endpoint below was probed live before it was written down, and
 * anything that needed a key we do not have, or answered 404/406, is listed at
 * the bottom under UNAVAILABLE rather than quietly included and left to fail at
 * 3am. A source list that lies about its coverage is worse than a short one.
 *
 * Two kinds of source, and the difference decides what we can DO with a job:
 *
 *   ats     Greenhouse, Lever, Ashby, Workable, SmartRecruiters. A company's
 *           own applicant tracking system. The posting links to a form we can
 *           actually fill in, and the schema is consistent per vendor. These
 *           are the ones an application can be prepared for end to end.
 *
 *   board   Remotive, Arbeitnow, 4dayweek, The Muse, WWR, Himalayas, Jobicy,
 *           RemoteOK, HN. Aggregators. Great for discovery, but most link out
 *           to somewhere else to apply — often back to an ATS we already read,
 *           which is exactly why dedupe matters more than volume.
 *
 * Every adapter returns the same normalised record and swallows its own
 * failures. One board being down at 3am must never stop the other fourteen.
 */
const SOURCES = [];

/** Shared fetch: a real UA, a timeout, and no throw that can take a run down. */
async function get(url, { json = true, timeoutMs = 20000, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: Object.assign({
        // Several boards 403 an unidentified client. Saying who we are is both
        // more honest and more reliable than pretending to be a browser.
        'User-Agent': 'ClockworkJobs/1.0 (+https://theclockworkhub.com)',
        'Accept': json ? 'application/json' : 'application/rss+xml, text/xml, */*'
      }, headers)
    });
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
    return { ok: true, status: r.status, body: json ? await r.json() : await r.text() };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e).slice(0, 200) };
  } finally { clearTimeout(t); }
}

// ── Normalisation ───────────────────────────────────────────────────────────

function text(v, max = 20000) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Strip HTML to something a matcher and a human can both read. */
function plain(html, max = 20000) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    // Entities matter more than they look. Salary ranges arrive as
    // `<span>£325,000</span><span>&mdash;</span><span>£390,000</span>`, and an
    // undecoded &mdash; means the range separator never matches — the parser
    // then reads one figure instead of a band and understates the job.
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&(?:mdash|ndash|horbar);/g, '—').replace(/&hellip;/g, '…')
    .replace(/&(?:lsquo|rsquo);/g, "'").replace(/&(?:ldquo|rdquo);/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * The canonical posting. Every adapter produces this and nothing else, so the
 * scorer, the deduper and the UI each learn one shape rather than fifteen.
 */
function posting(o) {
  const title = text(o.title, 300);
  const company = text(o.company, 200);
  if (!title || !o.url) return null;          // unusable; drop rather than store a stub
  return {
    source: o.source,
    sourceKind: o.sourceKind || 'board',
    sourceId: text(o.sourceId || o.url, 300),
    title, company,
    location: text(o.location, 200),
    remote: !!o.remote,
    url: text(o.url, 1000),
    // Where an application is actually submitted. For an ATS this is a form we
    // can fill; for a board it is usually the same as `url` and often a
    // redirect to somebody else's site.
    applyUrl: text(o.applyUrl || o.url, 1000),
    ats: o.ats || null,
    description: plain(o.description),
    salaryText: text(o.salaryText, 200),
    employmentType: text(o.employmentType, 60),
    postedAt: toDate(o.postedAt),
    tags: (o.tags || []).map(t => text(t, 60)).filter(Boolean).slice(0, 25)
  };
}

// ── ATS adapters ────────────────────────────────────────────────────────────
// These take a company slug. The company lists live in companies.js so adding
// an employer is a data change, not a code change.

SOURCES.push({
  name: 'greenhouse', kind: 'ats', perCompany: true,
  async fetchFor(slug) {
    // content=true returns the full job description in the same call, which
    // saves one request per posting — and the description is what the matcher
    // and the cover letter are both built from.
    const r = await get(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
    if (!r.ok) return { ok: false, error: r.error, items: [] };
    const jobs = (r.body && r.body.jobs) || [];
    return {
      ok: true,
      items: jobs.map(j => posting({
        source: 'greenhouse', sourceKind: 'ats', ats: 'greenhouse',
        sourceId: `greenhouse:${slug}:${j.id}`,
        title: j.title, company: slug,
        location: j.location && j.location.name,
        url: j.absolute_url, applyUrl: j.absolute_url,
        description: j.content, postedAt: j.updated_at || j.first_published
      })).filter(Boolean)
    };
  }
});

SOURCES.push({
  name: 'lever', kind: 'ats', perCompany: true,
  async fetchFor(slug) {
    const r = await get(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
    // Lever answers {ok:false,error:"Document not found"} for a company that is
    // not theirs — a 200 that means "no". Treated as an empty board, not a bug.
    if (!r.ok || !Array.isArray(r.body)) return { ok: false, error: r.error || 'not a Lever board', items: [] };
    return {
      ok: true,
      items: r.body.map(j => posting({
        source: 'lever', sourceKind: 'ats', ats: 'lever',
        sourceId: `lever:${slug}:${j.id}`,
        title: j.text, company: slug,
        location: j.categories && j.categories.location,
        employmentType: j.categories && j.categories.commitment,
        url: j.hostedUrl, applyUrl: j.applyUrl || (j.hostedUrl ? j.hostedUrl + '/apply' : null),
        description: j.descriptionPlain || j.description,
        postedAt: j.createdAt ? new Date(j.createdAt) : null
      })).filter(Boolean)
    };
  }
});

SOURCES.push({
  name: 'ashby', kind: 'ats', perCompany: true,
  async fetchFor(slug) {
    const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`);
    if (!r.ok) return { ok: false, error: r.error, items: [] };
    const jobs = (r.body && r.body.jobs) || [];
    return {
      ok: true,
      items: jobs.map(j => posting({
        source: 'ashby', sourceKind: 'ats', ats: 'ashby',
        sourceId: `ashby:${slug}:${j.id}`,
        title: j.title, company: slug,
        location: j.location, remote: !!j.isRemote,
        employmentType: j.employmentType,
        url: j.jobUrl, applyUrl: j.applyUrl || j.jobUrl,
        description: j.descriptionPlain || j.descriptionHtml,
        salaryText: j.compensation && j.compensation.summaryComponents
          ? '' : (j.compensation && j.compensation.summary) || '',
        postedAt: j.publishedAt
      })).filter(Boolean)
    };
  }
});

SOURCES.push({
  name: 'workable', kind: 'ats', perCompany: true,
  async fetchFor(slug) {
    const r = await get(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`);
    if (!r.ok) return { ok: false, error: r.error, items: [] };
    const jobs = (r.body && r.body.jobs) || [];
    const company = (r.body && r.body.name) || slug;
    return {
      ok: true,
      items: jobs.map(j => posting({
        source: 'workable', sourceKind: 'ats', ats: 'workable',
        sourceId: `workable:${slug}:${j.shortcode || j.id}`,
        title: j.title, company,
        location: [j.city, j.state, j.country].filter(Boolean).join(', '),
        remote: /remote/i.test(j.location || '') || !!j.telecommuting,
        url: j.url || j.application_url, applyUrl: j.application_url || j.url,
        description: j.description, postedAt: j.published_on || j.created_at
      })).filter(Boolean)
    };
  }
});

SOURCES.push({
  name: 'smartrecruiters', kind: 'ats', perCompany: true,
  async fetchFor(slug) {
    const r = await get(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`);
    if (!r.ok) return { ok: false, error: r.error, items: [] };
    const jobs = (r.body && r.body.content) || [];
    return {
      ok: true,
      items: jobs.map(j => {
        const loc = j.location || {};
        return posting({
          source: 'smartrecruiters', sourceKind: 'ats', ats: 'smartrecruiters',
          sourceId: `smartrecruiters:${slug}:${j.id}`,
          title: j.name, company: (j.company && j.company.name) || slug,
          location: [loc.city, loc.region, loc.country].filter(Boolean).join(', '),
          remote: !!loc.remote,
          employmentType: j.typeOfEmployment && j.typeOfEmployment.label,
          url: j.ref || `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
          applyUrl: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
          postedAt: j.releasedDate
        });
      }).filter(Boolean)
    };
  }
});

// ── Board adapters ──────────────────────────────────────────────────────────
// Global feeds. One call each, no company list needed.

SOURCES.push({
  name: 'remotive', kind: 'board',
  async fetchAll() {
    const r = await get('https://remotive.com/api/remote-jobs?limit=500');
    if (!r.ok) return { ok: false, error: r.error, items: [] };
    return {
      ok: true,
      items: ((r.body && r.body.jobs) || []).map(j => posting({
        source: 'remotive', sourceId: `remotive:${j.id}`,
        title: j.title, company: j.company_name,
        location: j.candidate_required_location, remote: true,
        employmentType: j.job_type,
        url: j.url, description: j.description,
        salaryText: j.salary, postedAt: j.publication_date,
        tags: j.tags
      })).filter(Boolean)
    };
  }
});

SOURCES.push({
  name: 'arbeitnow', kind: 'board',
  async fetchAll() {
    const r = await get('https://www.arbeitnow.com/api/job-board-api');
    if (!r.ok) return { ok: false, error: r.error, items: [] };
    return {
      ok: true,
      items: ((r.body && r.body.data) || []).map(j => posting({
        source: 'arbeitnow', sourceId: `arbeitnow:${j.slug}`,
        title: j.title, company: j.company_name,
        location: j.location, remote: !!j.remote,
        url: j.url, description: j.description,
        // Unix seconds, not milliseconds — a straight new Date() here lands in 1970.
        postedAt: j.created_at ? new Date(j.created_at * 1000) : null,
        tags: [].concat(j.tags || [], j.job_types || [])
      })).filter(Boolean)
    };
  }
});

SOURCES.push({
  name: '4dayweek', kind: 'board',
  async fetchAll() {
    const r = await get('https://4dayweek.io/api/jobs');
    if (!r.ok) return { ok: false, error: r.error, items: [] };
    const jobs = (r.body && (r.body.jobs || r.body.data)) || [];
    return {
      ok: true,
      items: jobs.filter(j => !j.is_expired).map(j => posting({
        source: '4dayweek', sourceId: `4dayweek:${j.id || j.slug}`,
        title: j.title, company: j.company_name || (j.company && j.company.name),
        // Locations are an array of {country, continent, is_primary}; there is
        // no flat location string to read.
        location: (j.locations || []).map(l => l.country).filter(Boolean).join(', '),
        remote: j.work_arrangement === 'remote' ||
                (j.locations || []).some(l => l.work_arrangement === 'remote'),
        url: j.url || (j.slug ? `https://4dayweek.io/remote-job/${j.slug}` : null),
        // The list endpoint carries no description at all. Left empty rather
        // than faked — the matcher weights an empty description down, and the
        // detail page is a click away for a human.
        employmentType: j.schedule_type,
        // Unix SECONDS. Read raw, every 4dayweek posting dates to 1970.
        postedAt: j.posted ? new Date(j.posted * 1000) : null,
        tags: [j.category, j.level, '4-day week'].filter(Boolean)
      })).filter(Boolean)
    };
  }
});

SOURCES.push({
  name: 'themuse', kind: 'board',
  async fetchAll() {
    // 20k+ pages exist; we take the newest few rather than pretending to
    // mirror the whole thing on every run.
    const out = [];
    for (let page = 0; page < 5; page++) {
      const r = await get(`https://www.themuse.com/api/public/jobs?page=${page}&descending=true`);
      if (!r.ok) break;
      const items = (r.body && r.body.results) || [];
      if (!items.length) break;
      for (const j of items) {
        out.push(posting({
          source: 'themuse', sourceId: `themuse:${j.id}`,
          title: j.name, company: j.company && j.company.name,
          location: (j.locations || []).map(l => l.name).join(' · '),
          remote: (j.locations || []).some(l => /flexible|remote/i.test(l.name || '')),
          url: j.refs && j.refs.landing_page,
          description: j.contents, postedAt: j.publication_date,
          tags: (j.categories || []).map(c => c.name)
        }));
      }
    }
    return { ok: true, items: out.filter(Boolean) };
  }
});

SOURCES.push({
  name: 'himalayas', kind: 'board',
  async fetchAll() {
    const r = await get('https://himalayas.app/jobs/api?limit=100');
    if (!r.ok) return { ok: false, error: r.error, items: [] };
    return {
      ok: true,
      items: ((r.body && r.body.jobs) || []).map(j => posting({
        source: 'himalayas', sourceId: `himalayas:${j.guid || j.applicationLink}`,
        title: j.title,
        // Their bug, not ours: at limit >= 20 the feed returns the literal
        // strings "name" and "thumbnail_url" in place of the company's actual
        // name and logo. companySlug stays correct, so it is the reliable one.
        // Verified: 20 of 20 rows affected at limit=100, none at limit=3.
        company: (j.companyName && j.companyName !== 'name') ? j.companyName : j.companySlug,
        location: (j.locationRestrictions || []).join(', '), remote: true,
        url: j.applicationLink, description: j.description || j.excerpt,
        salaryText: j.salaryRange || '',
        postedAt: j.pubDate ? new Date(j.pubDate * 1000) : null,
        tags: [].concat(j.categories || [], j.seniority || [])
      })).filter(Boolean)
    };
  }
});

SOURCES.push({
  name: 'jobicy', kind: 'board',
  async fetchAll() {
    const r = await get('https://jobicy.com/api/v2/remote-jobs?count=50');
    if (!r.ok) return { ok: false, error: r.error, items: [] };
    return {
      ok: true,
      items: ((r.body && r.body.jobs) || []).map(j => posting({
        source: 'jobicy', sourceId: `jobicy:${j.id}`,
        title: j.jobTitle, company: j.companyName,
        location: j.jobGeo, remote: true,
        employmentType: (j.jobType || []).join(', '),
        url: j.url, description: j.jobDescription || j.jobExcerpt,
        salaryText: j.annualSalaryMin ? `${j.annualSalaryMin}–${j.annualSalaryMax} ${j.salaryCurrency || ''}`.trim() : '',
        postedAt: j.pubDate, tags: [].concat(j.jobIndustry || [], j.jobLevel || [])
      })).filter(Boolean)
    };
  }
});

SOURCES.push({
  name: 'remoteok', kind: 'board',
  async fetchAll() {
    const r = await get('https://remoteok.com/api');
    if (!r.ok || !Array.isArray(r.body)) return { ok: false, error: r.error || 'unexpected shape', items: [] };
    // The first element is RemoteOK's API terms, not a job. Their terms ask for
    // attribution and a followed link back, which the UI honours.
    return {
      ok: true,
      items: r.body.filter(j => j && j.id && j.position).map(j => posting({
        source: 'remoteok', sourceId: `remoteok:${j.id}`,
        title: j.position, company: j.company,
        location: j.location, remote: true,
        url: j.url || j.apply_url, description: j.description,
        salaryText: j.salary_min ? `$${j.salary_min}–$${j.salary_max}` : '',
        postedAt: j.date, tags: j.tags
      })).filter(Boolean)
    };
  }
});

SOURCES.push({
  name: 'weworkremotely', kind: 'board',
  async fetchAll() {
    const r = await get('https://weworkremotely.com/remote-jobs.rss', { json: false });
    if (!r.ok) return { ok: false, error: r.error, items: [] };
    return { ok: true, items: parseRss(r.body, 'weworkremotely') };
  }
});

SOURCES.push({
  name: 'hn-hiring', kind: 'board',
  async fetchAll() {
    // "Who is hiring" threads: one post per job, written by humans. No
    // structure at all, so the title is the whole line and the matcher earns
    // its keep here more than anywhere.
    const s = await get('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=3');
    if (!s.ok) return { ok: false, error: s.error, items: [] };
    const thread = ((s.body && s.body.hits) || []).find(h => /who is hiring/i.test(h.title || ''));
    if (!thread) return { ok: true, items: [] };
    const c = await get(`https://hn.algolia.com/api/v1/search?tags=comment,story_${thread.objectID}&hitsPerPage=200`);
    if (!c.ok) return { ok: false, error: c.error, items: [] };
    return {
      ok: true,
      items: ((c.body && c.body.hits) || []).filter(h => h.comment_text).map(h => {
        const body = plain(h.comment_text);
        const head = body.split('\n')[0] || body.slice(0, 160);
        return posting({
          source: 'hn-hiring', sourceId: `hn:${h.objectID}`,
          // The convention is "Company | Role | Location | ..." on line one.
          title: head.split('|').slice(1, 2).join('').trim() || head.slice(0, 140),
          company: head.split('|')[0].trim().slice(0, 120) || 'via HN',
          location: head.split('|').slice(2, 3).join('').trim(),
          remote: /remote/i.test(head),
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          description: body, postedAt: h.created_at
        });
      }).filter(Boolean)
    };
  }
});

/** Minimal RSS reader — enough for the two feeds we take, no XML dependency. */
function parseRss(xml, source) {
  const out = [];
  const items = String(xml).split(/<item[\s>]/i).slice(1);
  for (const raw of items.slice(0, 400)) {
    const pick = tag => {
      const m = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      if (!m) return '';
      return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
    };
    const title = plain(pick('title'), 300);
    const link = pick('link');
    if (!title || !link) continue;
    // WWR titles read "Company: Role". Splitting gives a real company column
    // instead of stuffing both into the title.
    const sep = title.indexOf(':');
    out.push(posting({
      source, sourceId: `${source}:${link}`,
      title: sep > 0 ? title.slice(sep + 1).trim() : title,
      company: sep > 0 ? title.slice(0, sep).trim() : '',
      location: plain(pick('region'), 120),
      remote: true, url: link,
      description: pick('description'), postedAt: pick('pubDate')
    }));
  }
  return out.filter(Boolean);
}

/**
 * UNAVAILABLE — probed, did not work, deliberately not wired up:
 *
 *   usajobs        403 without a free API key + registered email in the UA.
 *                  Add USAJOBS_KEY / USAJOBS_EMAIL and it can be added.
 *   adzuna         needs a free app id + key (ADZUNA_ID / ADZUNA_KEY).
 *   workatastartup 406 to a plain client; YC gates it.
 *   recruitee      per-company subdomains only; no directory to enumerate.
 *   personio       needs a numeric company id per employer.
 *   linkedin       automated access violates their terms and gets accounts
 *   indeed         restricted. Excluded on purpose — see the note in the
 *                  console. Their postings mostly reach us anyway, because
 *                  they syndicate FROM the ATSes above.
 */
const UNAVAILABLE = ['usajobs', 'adzuna', 'workatastartup', 'recruitee', 'personio', 'linkedin', 'indeed'];

module.exports = { SOURCES, UNAVAILABLE, posting, plain, text, get, parseRss };
