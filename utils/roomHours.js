/**
 * Business hours for Connect rooms/Studios. Times are host-local HH:MM with
 * the host's getTimezoneOffset() captured at save, so "open 9–5" means the
 * HOST's 9–5 wherever the visitor is. Overnight ranges (18:00–02:00) work:
 * the close leg counts against the previous day's schedule.
 */
function minutes(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function roomOpenNow(convo) {
  const h = convo && convo.hours;
  if (!h || !h.enabled) return true;
  const o = minutes(h.open), c = minutes(h.close);
  if (o == null || c == null || o === c) return true;
  const local = new Date(Date.now() - (h.tzOffset || 0) * 60000);
  const day = local.getUTCDay(), t = local.getUTCHours() * 60 + local.getUTCMinutes();
  const days = (h.days && h.days.length) ? h.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
  if (o < c) return days.includes(day) && t >= o && t < c;
  return (days.includes(day) && t >= o) || (days.includes((day + 6) % 7) && t < c);
}

// Advance-notice requirement in hours (0 = walk-ins welcome).
function noticeOf(convo) {
  const h = convo && convo.hours;
  const n = h && parseInt(h.noticeHours);
  return (n && n > 0) ? Math.min(168, n) : 0;
}

// The shape clients get — nothing when neither hours nor notice are in force.
function hoursPublic(convo) {
  const h = convo && convo.hours;
  const notice = noticeOf(convo);
  if (!h || (!h.enabled && !notice)) return null;
  return { enabled: !!h.enabled, open: h.open, close: h.close, days: h.days || [], tzOffset: h.tzOffset || 0, noticeHours: notice };
}

// "Opening soon": closed right now, but the doors open within `mins` minutes
// (default 30) — profiles show it as an almost-here badge next to the room.
function opensWithinMinutes(convo, mins = 30) {
  if (roomOpenNow(convo)) return false;
  const h = convo && convo.hours;
  if (!h || !h.enabled) return false;
  const o = minutes(h.open), c = minutes(h.close);
  if (o == null || c == null || o === c) return false;
  const local = new Date(Date.now() - (h.tzOffset || 0) * 60000);
  const day = local.getUTCDay(), t = local.getUTCHours() * 60 + local.getUTCMinutes();
  const days = (h.days && h.days.length) ? h.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
  for (let k = 0; k <= 1; k++) { // opens later today, or just past midnight
    const d = (day + k) % 7;
    if (!days.includes(d)) continue;
    const delta = (o + k * 1440) - t;
    if (delta > 0 && delta <= mins) return true;
  }
  return false;
}

/**
 * The public shape of a room's event, or null when the room isn't one.
 *
 * Shared because three endpoints serialize rooms — the Messenger list, the
 * Studio page, and the public Studio card — and a countdown that disagrees
 * with itself between two of them is worse than no countdown. `live` and
 * `soon` are derived here, once, rather than left to each client to work out
 * from raw timestamps and drift apart.
 */
function eventPublic(convo) {
  const e = convo && convo.event;
  if (!e || !e.startsAt) return null;
  const now = Date.now();
  const start = new Date(e.startsAt).getTime();
  const end = e.endsAt ? new Date(e.endsAt).getTime() : null;
  return {
    startsAt: e.startsAt,
    endsAt: e.endsAt || null,
    ticketUrl: e.ticketUrl || null,
    // Live from the start until the end — or, with no end set, for two hours,
    // so a host who forgets to set one doesn't leave a room "live" forever.
    live: now >= start && now < (end || start + 2 * 60 * 60 * 1000),
    soon: now < start && (start - now) <= 60 * 60 * 1000,
    startsInMs: start - now
  };
}

module.exports = { roomOpenNow, hoursPublic, noticeOf, minutes, opensWithinMinutes, eventPublic };
