/**
 * barberSchedule — wall-clock in, instants out.
 *
 * Every bug a booking site has ever had lives in this file's subject matter: a
 * client in Denver books "2:30" and the barber in New York finds an empty
 * chair; the shop opens at nine all year and the clocks change in March; a slot
 * is offered twice because "is it free" was asked of a string.
 *
 * So the rules here are narrow and absolute:
 *   - The shop's hours are wall-clock minutes in the shop's own timezone.
 *   - Everything stored and compared is a UTC instant.
 *   - The conversion between them goes through zonedToUtc(), which asks the
 *     platform's own timezone database rather than doing arithmetic on offsets.
 *
 * Pure functions, no database, no Date.now() unless it is handed in — which is
 * what makes the tests able to stand in March 2026 at 2am and check that the
 * hour that does not exist is not offered as an appointment.
 */

const DAY_MS = 86400000;

/** The tz's UTC offset in ms at a given instant (positive east of Greenwich). */
function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  // Some locales render midnight as hour 24; Date.UTC would roll the day.
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asIfUtc - date.getTime();
}

/**
 * '2026-03-08' + 150 minutes, in America/New_York, as a real instant.
 *
 * Resolved twice on purpose: the first pass uses the offset in force at the
 * naive timestamp, which is the wrong side of a DST change for times near the
 * boundary; the second pass re-asks using the answer. Two passes is enough for
 * every real transition (they are at most an hour, and never twice in a day).
 */
function zonedToUtc(dateStr, minutes, tz) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, Number(minutes) || 0, 0, 0);
  let ts = naive - tzOffsetMs(new Date(naive), tz);
  ts = naive - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

/** Minutes from local midnight for an instant, as seen in tz. */
function localMinutes(date, tz) {
  const p = zonedParts(date, tz);
  return p.hour * 60 + p.minute;
}

/** Calendar parts of an instant as seen in tz. */
function zonedParts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: (+p.hour) % 24, minute: +p.minute,
    weekday: WD[p.weekday],
    dateStr: `${p.year}-${p.month}-${p.day}`
  };
}

/** 'YYYY-MM-DD' for an instant, as seen in tz. */
function dayKey(date, tz) { return zonedParts(date, tz).dateStr; }

/** Which day of the week 'YYYY-MM-DD' falls on (0 = Sunday). */
function weekdayOf(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 'YYYY-MM-DD' n days after another. Stays in calendar space, so DST cannot shift it. */
function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

function isDateStr(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }

/** '2:30 PM' in the shop's timezone. */
function timeLabel(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date);
}

/** 'Thu, Sep 10' in the shop's timezone. */
function dateLabel(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric'
  }).format(date);
}

/**
 * The sentence a client reads in their email:
 * 'Thursday, September 10, 2026 at 2:30 PM EDT'. The zone name is not
 * decoration — it is the difference between a confirmation and an argument.
 */
function longLabel(date, tz) {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  }).format(date);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
  }).format(date);
  return `${day} at ${time}`;
}

/** Minutes from local midnight → '9:00 AM', for the hours editor. */
function minutesLabel(mins) {
  const m = Math.max(0, Math.min(1439, Math.round(Number(mins) || 0)));
  const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${ampm}`;
}

/** Do [aStart, aEnd) and [bStart, bEnd) share any time at all? */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/**
 * Every start time a service of `durationMin` could take on `dateStr`.
 *
 * Excluded, in order: closed days and one-off closures; anything that would run
 * past closing; anything inside the lead time (nobody wants a booking for eight
 * minutes from now); and anything overlapping a booking already on the books.
 *
 * `bookings` are live appointments only — cancelled ones must be filtered by
 * the caller, since a cancelled 2:30 is a free 2:30.
 */
function buildSlots({ dateStr, shop, durationMin, bookings = [], now = new Date() }) {
  if (!isDateStr(dateStr)) return [];
  const tz = shop.timezone || 'America/New_York';
  const dur = Math.max(5, Math.round(Number(durationMin) || 30));
  const step = Math.max(5, Math.round(Number(shop.slotStepMin) || 15));
  const lead = Math.max(0, Number(shop.leadMinutes) || 0) * 60000;

  if ((shop.closures || []).includes(dateStr)) return [];

  const wd = weekdayOf(dateStr);
  const row = (shop.hours || []).find(h => Number(h.day) === wd);
  if (!row || row.closed) return [];

  const open = Number(row.open), close = Number(row.close);
  if (!(close > open)) return [];

  const busy = bookings.map(b => ({ s: new Date(b.startsAt), e: new Date(b.endsAt) }));
  const earliest = now.getTime() + lead;
  const out = [];

  for (let t = open; t + dur <= close; t += step) {
    const start = zonedToUtc(dateStr, t, tz);

    // The hour that does not exist. On the morning the clocks spring forward,
    // 2:30am is not a time — asking for it lands on 3:30am, and so does asking
    // for 3:30am. Offered as written, the grid shows the same instant twice and
    // two people book "different" slots into one chair. If the instant does not
    // read back as the wall-clock we asked for, that wall-clock did not happen.
    if (localMinutes(start, tz) !== t % 1440) continue;

    const end = new Date(start.getTime() + dur * 60000);
    if (start.getTime() < earliest) continue;
    if (busy.some(b => overlaps(start, end, b.s, b.e))) continue;
    out.push({ start: start.toISOString(), label: timeLabel(start, tz) });
  }
  return out;
}

module.exports = {
  tzOffsetMs, zonedToUtc, zonedParts, localMinutes, dayKey, weekdayOf, addDays, isDateStr,
  timeLabel, dateLabel, longLabel, minutesLabel, overlaps, buildSlots, DAY_MS
};
