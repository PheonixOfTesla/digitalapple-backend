/**
 * Your resume, read the way an applicant tracking system reads it.
 *
 * Two jobs, and the second is the one nobody builds:
 *
 *   parseResume()  pull out skills, titles, dates, years of experience — the
 *                  structure the matcher scores against.
 *
 *   atsReport()    tell you what an ATS will FAIL to read. This is where
 *                  applications die silently. A resume exported as an image,
 *                  or laid out in two columns, or with the phone number in a
 *                  page header, parses to garbage — and no employer ever tells
 *                  you that. You just never hear back, and conclude the market
 *                  is bad.
 *
 * PDF and DOCX both go through text extraction first, because that is exactly
 * what the real systems do: Workday, Greenhouse and Taleo all run a text
 * extractor and then regex the result. If our extractor cannot find your job
 * titles, theirs probably cannot either.
 */
const SKILLS = require('./skills');

/** Extract raw text. Returns { text, kind, pages } or throws with a clear reason. */
async function extractText(buffer, filename = '', mimetype = '') {
  const name = String(filename).toLowerCase();
  const isPdf = /pdf/.test(mimetype) || name.endsWith('.pdf');
  const isDocx = /wordprocessingml|officedocument/.test(mimetype) || name.endsWith('.docx');
  const isDoc = name.endsWith('.doc') && !isDocx;

  if (isDoc) {
    // Legacy binary .doc is a different format entirely and not worth a
    // dependency — say so rather than returning mush.
    const e = new Error('Old .doc files cannot be read. Save as PDF or .docx and upload again.');
    e.code = 'UNSUPPORTED'; throw e;
  }

  if (isPdf) {
    // pdf-parse v2 exports a PDFParse class, not the callable of v1. Worth
    // pinning in memory: the v1 call signature is what every example online
    // still shows, and it fails with "pdf is not a function".
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const out = await parser.getText();
      return { text: normalise(out.text || ''), kind: 'pdf', pages: out.total || 1 };
    } finally {
      // Holds a worker open otherwise, and an upload endpoint that leaks one
      // per resume runs a server out of handles quietly.
      if (typeof parser.destroy === 'function') { try { await parser.destroy(); } catch (e) {} }
    }
  }
  if (isDocx) {
    const mammoth = require('mammoth');
    const out = await mammoth.extractRawText({ buffer });
    return { text: normalise(out.value || ''), kind: 'docx', pages: null };
  }
  const e = new Error('Upload a PDF or a .docx file.');
  e.code = 'UNSUPPORTED'; throw e;
}

function normalise(t) {
  return String(t)
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    // Ligatures survive PDF extraction and break keyword matching: a resume
    // saying "workflow" can come out "work[fl]ow" and match nothing.
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Structure ───────────────────────────────────────────────────────────────

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
// Bare domains count. Almost nobody writes "https://github.com/me" on a
// resume — they write "github.com/me", and a scheme-only pattern finds no
// GitHub profile on the majority of real engineering resumes.
const URL_ANY = /\b(?:https?:\/\/|www\.)[^\s)>\]]+|\b(?:github|gitlab|linkedin|behance|dribbble|medium|stackoverflow)\.com\/[^\s)>\],;]+|\b[a-z0-9-]+\.(?:com|io|dev|app|net|org|me|co)\/[^\s)>\],;]+/gi;

const SECTION = /^(experience|work experience|professional experience|employment|education|skills|technical skills|projects|summary|profile|objective|certifications|awards|publications)\b/i;

// Month-year and year-only ranges, including "Present".
const DATE_RANGE = new RegExp(
  '\\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s*)?(\\d{4})' +
  '\\s*(?:-|–|—|to|until)\\s*' +
  '((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s*)?(\\d{4}|present|current|now)\\b', 'gi');

const SENIOR_WORDS = /\b(senior|sr\.?|staff|principal|lead|architect|head of|director|vp|founding)\b/i;

/**
 * Years of experience, from the dates on the page.
 *
 * Union of the intervals, not a sum: two jobs held at once are one stretch of
 * career, and summing them invents years that would not survive an interview.
 */
function yearsFromRanges(text) {
  const spans = [];
  DATE_RANGE.lastIndex = 0;
  let m;
  const nowYear = new Date().getUTCFullYear();
  while ((m = DATE_RANGE.exec(text))) {
    const from = parseInt(m[2], 10);
    const toRaw = String(m[4]).toLowerCase();
    const to = /present|current|now/.test(toRaw) ? nowYear : parseInt(toRaw, 10);
    if (!from || !to || to < from || from < 1970 || to > nowYear + 1) continue;
    spans.push([from, Math.min(to, nowYear)]);
  }
  if (!spans.length) return { years: null, spans: [] };
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [spans[0].slice()];
  for (const [s, e] of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const years = merged.reduce((n, [s, e]) => n + (e - s), 0);
  return { years, spans: merged };
}

/** Which skills from the taxonomy appear, and how often. */
function findSkills(text) {
  const hay = ' ' + text.toLowerCase().replace(/[^a-z0-9+#./ -]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const found = [];
  for (const [canonical, aliases] of Object.entries(SKILLS.SKILLS)) {
    let count = 0;
    for (const alias of aliases) {
      // Word-boundary matching on an alias that may contain +, # or . — a
      // naive \b breaks on "c++" and "node.js" and silently finds nothing.
      const needle = ' ' + alias.toLowerCase() + ' ';
      let i = 0;
      while ((i = hay.indexOf(needle, i)) !== -1) { count++; i += needle.length - 1; }
    }
    if (count) found.push({ skill: canonical, mentions: count, group: SKILLS.groupOf(canonical) });
  }
  return found.sort((a, b) => b.mentions - a.mentions);
}

/** Job titles held, most recent first where the layout allows. */
function findTitles(text) {
  const out = [];
  const TITLE = /\b((?:senior|sr\.?|staff|principal|lead|junior|jr\.?|founding)?\s*(?:full[\s-]?stack|fullstack|back[\s-]?end|front[\s-]?end|software|web|platform|application|product|data|mobile|devops|site reliability)?\s*(?:engineer|developer|architect|programmer))\b/gi;
  let m;
  while ((m = TITLE.exec(text))) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (t.length > 4 && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

function parseResume(text) {
  const emailM = text.match(EMAIL);
  const phoneM = text.match(PHONE);
  const links = Array.from(new Set((text.match(URL_ANY) || []).map(u => u.replace(/[.,;]$/, ''))));
  const { years, spans } = yearsFromRanges(text);
  const skills = findSkills(text);
  const titles = findTitles(text);

  return {
    email: emailM ? emailM[0] : null,
    phone: phoneM ? phoneM[0] : null,
    links: links.slice(0, 12),
    github: links.find(l => /github\.com/i.test(l)) || null,
    linkedin: links.find(l => /linkedin\.com/i.test(l)) || null,
    yearsExperience: years,
    careerSpans: spans,
    // Claimed seniority is what the page says; the matcher weighs it against
    // years, because "Senior" after eighteen months means something different.
    seniority: SENIOR_WORDS.test(text.slice(0, 1200)) ? 'senior' : 'mid',
    titles,
    skills,
    skillNames: skills.map(s => s.skill),
    words: text.split(/\s+/).filter(Boolean).length
  };
}

// ── The part nobody builds ──────────────────────────────────────────────────

/**
 * What an ATS will get wrong, in the order it will hurt.
 *
 * Every check here maps to a real, silent rejection: not a style opinion, a
 * parse failure. Severity `fatal` means the application is very likely
 * discarded before a human sees it.
 */
function atsReport(text, parsed, meta = {}) {
  const issues = [];
  const add = (severity, title, detail) => issues.push({ severity, title, detail });

  const words = parsed.words;

  if (words < 50) {
    add('fatal', 'Almost no text could be extracted',
      meta.kind === 'pdf'
        ? 'This PDF is probably a scan or an exported image. An ATS reads text, not pictures — it will see an empty resume. Re-export from the original document as a text PDF.'
        : 'The file produced almost no readable text. Re-save it and try again.');
  } else if (words < 200) {
    add('warn', 'Very little text extracted',
      `Only ${words} words came out. If your resume is longer than that on screen, some of it is in a text box, image, or column an ATS will skip.`);
  }

  if (!parsed.email) {
    add('fatal', 'No email address found',
      'If the parser cannot find your email, neither can theirs — and there is no way to contact you. It may be sitting in a page header or footer, which most ATSes do not read. Put it in the body of the first page.');
  }
  if (!parsed.phone) {
    add('warn', 'No phone number found',
      'Same cause as a missing email: headers, footers and text boxes are commonly skipped.');
  }

  if (!parsed.yearsExperience) {
    add('warn', 'No date ranges found',
      'Employment dates could not be read, so seniority filters that ask for "5+ years" will not match you. Write them as "Jan 2021 – Present" in the body text.');
  }

  if (!parsed.skills.length) {
    add('fatal', 'No recognised technical skills',
      'Not one known technology was found. Keyword filters are the first gate at most companies, and this resume would pass none of them.');
  } else if (parsed.skills.length < 6) {
    add('warn', 'Thin on recognised skills',
      `Only ${parsed.skills.length} technologies matched. Name your stack explicitly — ATS keyword matching is literal and does not infer that "built the payments system" means Stripe.`);
  }

  // Multi-column layouts are the classic silent killer: the extractor reads
  // across both columns and produces interleaved nonsense, so no line means
  // anything. Detected by lines that pack many short tokens with wide gaps.
  const lines = text.split('\n');
  const suspicious = lines.filter(l => l.length > 60 && (l.match(/ {3,}/g) || []).length >= 2).length;
  if (suspicious > Math.max(4, lines.length * 0.06)) {
    add('fatal', 'Looks like a multi-column layout',
      `${suspicious} lines read as two columns merged together. An ATS flattens the page top-to-bottom, so a side-by-side design comes out as scrambled sentences. Single column is the only layout that reliably survives.`);
  }

  const sections = lines.filter(l => SECTION.test(l.trim())).length;
  if (sections < 2) {
    add('warn', 'Standard section headings missing',
      'Parsers look for the words Experience, Education and Skills to split the document. Creative headings like "Where I have been" are not recognised.');
  }

  if (!parsed.titles.length) {
    add('warn', 'No job titles recognised',
      'Titles could not be identified, which means role-matching has nothing to work with. State them plainly — "Full-Stack Software Engineer" rather than "Chief Problem Solver".');
  }

  if (meta.kind === 'pdf' && meta.pages > 3) {
    add('warn', 'Long for a resume', `${meta.pages} pages. Nothing breaks, but the parse quality drops and most screeners read the first page only.`);
  }

  const fatal = issues.filter(i => i.severity === 'fatal').length;
  // A blunt number, because "your resume is fine" and "no employer can read
  // this" should not look similar.
  const score = Math.max(0, 100 - fatal * 34 - issues.filter(i => i.severity === 'warn').length * 8);

  return {
    score,
    passes: fatal === 0,
    issues,
    summary: fatal
      ? `${fatal} problem${fatal > 1 ? 's' : ''} that will stop this resume being read at all.`
      : issues.length
        ? `Readable, with ${issues.length} thing${issues.length > 1 ? 's' : ''} worth fixing.`
        : 'Parses cleanly — an ATS will read everything on this page.'
  };
}

/** One call: bytes in, everything out. */
async function readResume(buffer, filename, mimetype) {
  const meta = await extractText(buffer, filename, mimetype);
  const parsed = parseResume(meta.text);
  const ats = atsReport(meta.text, parsed, meta);
  return { text: meta.text, kind: meta.kind, pages: meta.pages, parsed, ats };
}

module.exports = { readResume, extractText, parseResume, atsReport, yearsFromRanges, findSkills, normalise };
