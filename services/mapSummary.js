/**
 * mapSummary — the CORE node's end-to-end read of a map.
 *
 * WHAT WAS WRONG
 * The old synthesizeCoreDetail() walked only the first row of the tree. It
 * pasted the depth-1 statements together, capped at four, and stopped:
 *
 *   "Requirements: You need specific tools and criteria to scale a Shopify
 *    theme shop. Steps: Establish a clear roadmap for scaling your Shopify
 *    theme shop. Documents: Prepare legal forms... No steps resolved yet —
 *    keep developing the branches (50% grounded)."
 *
 * Three separate failures in one paragraph:
 *   1. It is not a summary, it is the first row of the tree pasted together —
 *      every layer beneath it (the specifics, and the actions the map exists
 *      to produce) went unmentioned.
 *   2. The slice(0,4) silently dropped the fifth domain, so a five-domain map
 *      described four of them.
 *   3. It carried its own arithmetic, frozen at generation time, and the panel
 *      directly above it recomputes from the live tree. The card read "No
 *      steps resolved yet ... (50% grounded)" while the header on the same
 *      screen read "8 OF 20 RESOLVED · 61%". Two numbers, one screen,
 *      contradicting each other.
 *
 * WHAT THIS DOES
 * Walks the ENTIRE tree and reads it end to end: the premise, every domain it
 * turns on, what those domains open into underneath, where it bottoms out in
 * concrete actions, and what is still unanswered. It carries NO percentages
 * and no resolved counts — the meter owns those and computes them live, so
 * prose can never contradict it again.
 *
 * Takes flat nodes, so the generator and the backfill share one implementation
 * and cannot drift apart.
 */

/** Trim, collapse whitespace, cut on a word boundary, drop a trailing period. */
function clean(s, max = 120) {
  let t = String(s || '').trim().replace(/\s+/g, ' ');
  if (t.length > max) t = t.slice(0, max - 1).replace(/[\s,;:]+\S*$/, '') + '…';
  return t.replace(/\.+$/, '');
}

/**
 * Core statements are stored with a generator prefix ("Mapping: How to …").
 * That prefix is fine as a node title and reads badly mid-sentence, so it comes
 * off before the premise is used in prose.
 */
function premiseOf(s) {
  return clean(String(s || '').replace(/^\s*(mapping|map|plan|blueprint)\s*[:—-]\s*/i, ''), 160);
}

/** "a, b, and c" */
function list(items, joiner = 'and') {
  const a = items.filter(Boolean);
  if (!a.length) return '';
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} ${joiner} ${a[1]}`;
  return `${a.slice(0, -1).join(', ')}, ${joiner} ${a[a.length - 1]}`;
}

/**
 * Normalize either shape into a flat array of
 * { id, parentId, depth, label, statement, terminal, action, needsInput }.
 * Accepts flat snapshot nodes OR the generator's nested roots (root.stars).
 */
function flatten(input) {
  const out = [];
  const push = (n, depth, parentId) => {
    const id = String(n._id || n.id || `${depth}:${out.length}`);
    out.push({
      id,
      parentId: parentId != null ? String(parentId)
        : (n.parentNodeId ? String(n.parentNodeId) : null),
      depth: typeof n.depth === 'number' ? n.depth : depth,
      label: n.label || n.title || '',
      statement: n.statement || '',
      terminal: !!n.terminal,
      action: n.action || '',
      needsInput: !!n.needsInput || n.status === 'needs_input'
    });
    for (const kid of (n.stars || n.children || [])) push(kid, depth + 1, id);
  };
  if (Array.isArray(input)) {
    const nested = input.some(n => (n.stars || n.children || []).length);
    if (nested) input.forEach(n => push(n, 1, null));
    else input.forEach(n => push(n, typeof n.depth === 'number' ? n.depth : 1, n.parentNodeId));
  }
  return out.filter(n => n.depth > 0 && (n.label || n.statement));
}

/**
 * Build the CORE detail: an end-to-end read of the whole map.
 *
 * @param {Array}  input        flat snapshot nodes, or nested generator roots
 * @param {string} premise      the map's premise / core statement
 * @param {'actionable'|'overview'} determination
 * @returns {string}
 */
function summarizeMap(input, premise, determination = 'actionable') {
  const noun = determination === 'overview' ? 'account' : 'plan';
  const nodes = flatten(input);
  const P = premiseOf(premise) || 'this map';

  if (!nodes.length) {
    return `This ${noun} maps ${P}. Nothing is developed underneath it yet — open a branch to start.`;
  }

  const byParent = new Map();
  for (const n of nodes) {
    const k = n.parentId || 'root';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(n);
  }

  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
  const domains = nodes.filter(n => n.depth === 1);
  const terminals = nodes.filter(n => n.terminal && (n.action || n.statement));
  const open = nodes.filter(n => n.needsInput);

  const parts = [];

  /* 1 ── the through-line: every domain, never truncated. */
  if (domains.length) {
    parts.push(
      `End to end, ${P} turns on ${domains.length} ${domains.length === 1 ? 'thing' : 'things'} — ` +
      `${list(domains.map(d => clean(d.label, 44)))}.`
    );
  } else {
    parts.push(`End to end, this ${noun} maps ${P}.`);
  }

  /* 2 ── what those domains open into: one layer down, in the map's own words.
     This is the layer the old summary never reached. */
  const opens = [];
  for (const d of domains) {
    const kids = (byParent.get(d.id) || []).filter(k => k.label || k.statement);
    if (!kids.length) continue;
    const names = kids.slice(0, 2).map(k => clean(k.label || k.statement, 40).toLowerCase());
    if (names.length) opens.push(`${clean(d.label, 40)} into ${list(names)}`);
  }
  if (opens.length) {
    // When the list is truncated the tail phrase supplies the closing "and",
    // so the list itself must not also add one — otherwise it reads
    // "…, and Cost & Time into setup costs, and on through the rest".
    const shown = opens.slice(0, 4);
    const truncated = opens.length > shown.length;
    parts.push(truncated
      ? `Following it down: ${shown.join('; ')}, and on through the rest.`
      : `Following it down: ${list(shown, 'and')}.`);
  }

  /* 3 ── how deep it actually goes, and where it lands. The actions are the
     point of the whole map, and the old summary never named one. */
  if (maxDepth >= 3) {
    parts.push(`It keeps going ${maxDepth} layers past the core, and the bottom layer is where it stops describing and starts instructing.`);
  }
  if (terminals.length) {
    const picks = terminals.slice(0, 3).map(t => `"${clean(t.action || t.statement, 96)}"`);
    parts.push(
      `${terminals.length} of those endpoints are moves you could start on, among them ${list(picks)}.`
    );
  }

  /* 4 ── what is genuinely unanswered. No percentages: the meter above this
     card computes those live, and a frozen number here would fight it. */
  if (open.length) {
    const names = open.slice(0, 2).map(o => `"${clean(o.label || o.statement, 46)}"`);
    parts.push(`Still unanswered: ${list(names)}${open.length > 2 ? `, and ${open.length - 2} more` : ''} — answer those and the read sharpens.`);
  } else if (terminals.length) {
    parts.push(`Nothing is waiting on you — open any branch and follow it to the bottom.`);
  }

  return parts.join(' ');
}

module.exports = { summarizeMap, flatten, list, clean };
