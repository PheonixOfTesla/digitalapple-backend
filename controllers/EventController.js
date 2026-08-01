/**
 * EventController — self-hosted ticketing, native to Clockwork.
 *
 * Any member creates an event, attaches a Studio or a Messenger channel if it
 * is a Clockwork one, sets tiers, and sells. Money moves on the Stripe Connect
 * rail the paid-room door already uses: the host's Express account receives,
 * Clockwork takes 3.7% + $1.79 (services/ticketing).
 *
 *   POST   /events                       create (draft)
 *   PATCH  /events/:id                   edit / publish / cancel
 *   POST   /events/:id/room              attach a Studio or channel
 *   GET    /events                       browse published
 *   GET    /events/mine                  my events, with sales
 *   GET    /events/:slugOrId             one event
 *   POST   /events/:id/checkout          buy — or claim, when free
 *   GET    /tickets/:code                THE RECOVERY URL — no login
 *   POST   /tickets/:code/scan           the door
 *   GET    /events/:id/attendees         host only
 *
 * DELIVERY: email is best-effort, the URL is the guarantee. Checkout returns the
 * ticket URL directly, and /tickets/:code needs no account, so a buyer whose
 * email bounced still has a ticket they can open, screenshot or forward.
 */
const express = require('express');
const mongoose = require('mongoose');
const Event = require('../models/Event');
const Ticket = require('../models/Ticket');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const { verifyToken, optionalAuth } = require('../middleware/auth');
const tickets = require('../services/ticketing');

const router = express.Router();

const SITE = process.env.SITE_URL || 'https://www.theclockworkhub.com';

/** The URL a buyer can always open, even if no email ever arrives. */
function ticketUrl(code) { return `${SITE}/t/${encodeURIComponent(code)}`; }
function eventUrl(ev) { return `${SITE}/e/${encodeURIComponent(ev.slug || ev._id)}`; }

function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

/** URL-safe slug, with a short random suffix so two "summer-jam" never collide. */
async function makeSlug(title) {
  const base = clean(title, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'event';
  for (let i = 0; i < 5; i++) {
    const s = base + '-' + Math.random().toString(36).slice(2, 7);
    if (!(await Event.exists({ slug: s }))) return s;
  }
  return base + '-' + Date.now().toString(36);
}

async function isAdmin(userId) {
  try { const u = await User.findById(userId).select('role').lean(); return !!(u && u.role === 'admin'); }
  catch (e) { return false; }
}

function stripe() {
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
}

/**
 * Where this event's money lands — the host's Express account when it can take
 * transfers, otherwise the platform. Same rule the paid-room door uses.
 */
async function payoutDest(hostId) {
  try {
    const host = await User.findById(hostId).select('stripeAccountId').lean();
    if (!host || !host.stripeAccountId) return null;
    const acct = await stripe().accounts.retrieve(host.stripeAccountId);
    if (acct && acct.capabilities && acct.capabilities.transfers === 'active') return host.stripeAccountId;
  } catch (e) { /* fall back to platform */ }
  return null;
}

/**
 * WHY the money cannot move yet, not just that it cannot.
 *
 * payoutDest() is a yes/no on `transfers === 'active'`, which is the right test
 * for routing a charge and the wrong thing to show a person. Stripe flips that
 * capability some time AFTER onboarding is submitted, so a host who has just
 * finished handing over their bank details was being told "no bank connected
 * yet" — which is false, and reads as though the whole thing failed.
 *
 * Four states, four different sentences, one of which is an action:
 *   none        no account at all — start
 *   incomplete  Stripe wants more from them — finish, and we can say what
 *   pending     everything is in, Stripe is checking — wait, nothing to do
 *   ready       sell
 */
async function payoutStatus(hostId) {
  try {
    const host = await User.findById(hostId).select('stripeAccountId').lean();
    if (!host || !host.stripeAccountId) return { state: 'none', needs: [] };
    const acct = await stripe().accounts.retrieve(host.stripeAccountId);
    if (!acct) return { state: 'none', needs: [] };

    if (acct.capabilities && acct.capabilities.transfers === 'active') {
      return { state: 'ready', needs: [], payoutsEnabled: !!acct.payouts_enabled };
    }
    const req = acct.requirements || {};
    const due = [].concat(req.currently_due || [], req.past_due || []);
    if (!acct.details_submitted || due.length) {
      // The raw requirement keys are Stripe's ("individual.verification.document"),
      // so hand back something a person can read.
      return { state: 'incomplete', needs: due.slice(0, 6).map(humanRequirement) };
    }
    return { state: 'pending', needs: [], disabledReason: req.disabled_reason || null };
  } catch (e) {
    console.error('payout status:', e.message);
    // Unknown is not the same as missing. Saying "no bank connected" because
    // Stripe timed out is how a host is told to redo work they already did.
    return { state: 'unknown', needs: [] };
  }
}

/** Stripe's requirement keys, in English. */
function humanRequirement(key) {
  const k = String(key || '');
  if (/verification\.document/.test(k)) return 'a photo of your ID';
  if (/external_account/.test(k)) return 'your bank account details';
  if (/tax_id|ssn_last_4|id_number/.test(k)) return 'your tax or ID number';
  if (/dob/.test(k)) return 'your date of birth';
  if (/address/.test(k)) return 'your address';
  if (/phone/.test(k)) return 'a phone number';
  if (/email/.test(k)) return 'an email address';
  if (/url|business_profile/.test(k)) return 'a few business details';
  if (/name/.test(k)) return 'your name';
  return k.replace(/[._]/g, ' ');
}

/** Validate and normalise tiers coming from a host. */
function parseTiers(raw) {
  const out = [];
  for (const t of (Array.isArray(raw) ? raw : []).slice(0, 12)) {
    const name = clean(t && t.name, 60);
    if (!name) continue;
    const priceCents = Math.max(0, Math.round(Number(t.priceCents) || 0));
    // A price between free and the floor cannot be charged: the flat fee would
    // exceed the ticket and Stripe rejects an application fee larger than the
    // amount. Refuse it at creation rather than at somebody's checkout.
    if (!tickets.priceIsSellable(priceCents)) {
      return { error: `"${name}" is ${tickets.usd(priceCents)} — tickets are either free or at least ${tickets.usd(tickets.MIN_PAID_CENTS)}.` };
    }
    let capacity = t.capacity == null || t.capacity === '' ? null : Math.round(Number(t.capacity));
    if (capacity != null && (!Number.isFinite(capacity) || capacity < 1)) capacity = null;
    out.push({ name, priceCents, capacity, description: clean(t.description, 200) });
  }
  if (!out.length) return { error: 'Add at least one ticket type.' };
  return { tiers: out };
}

/** The public shape of an event. */
function publicEvent(ev, opts = {}) {
  const o = {
    id: ev._id, slug: ev.slug, url: eventUrl(ev),
    title: ev.title, description: ev.description, coverImage: ev.coverImage,
    startsAt: ev.startsAt, endsAt: ev.endsAt, tzOffset: ev.tzOffset,
    status: ev.status, visibility: ev.visibility, category: ev.category,
    venue: (ev.venue && ev.venue.name) ? ev.venue : null,
    roomId: ev.roomId || null,
    online: !!ev.roomId && !(ev.venue && ev.venue.name),
    hostId: ev.hostId,
    tiers: (ev.tiers || []).map(t => ({
      id: t._id, name: t.name, description: t.description || '',
      priceCents: t.priceCents, price: t.priceCents ? tickets.usd(t.priceCents) : 'Free',
      capacity: t.capacity, sold: t.sold || 0,
      soldOut: t.capacity != null && (t.sold || 0) >= t.capacity,
      // What the buyer actually pays. The service fee is ON TOP of the host's
      // price — hosts set what they want to receive, buyers see the total
      // before they commit, and nobody discovers a fee at the last screen.
      totalCents: t.priceCents ? t.priceCents + tickets.serviceFee(t.priceCents) : 0,
      feeCents: t.priceCents ? tickets.serviceFee(t.priceCents) : 0
    }))
  };
  if (opts.host) {
    o.soldTotal = (ev.tiers || []).reduce((n, t) => n + (t.sold || 0), 0);
    o.grossCents = (ev.tiers || []).reduce((n, t) => n + (t.sold || 0) * t.priceCents, 0);
  }
  return o;
}

/* ─────────────────────────── create & manage ─────────────────────────── */

router.post('/', verifyToken, async (req, res) => {
  try {
    const b = req.body || {};
    const title = clean(b.title, 140);
    if (!title) return res.status(400).json({ error: 'Give the event a name.' });
    const startsAt = new Date(b.startsAt);
    if (isNaN(startsAt.getTime())) return res.status(400).json({ error: 'When does it start?' });
    let endsAt = null;
    if (b.endsAt) {
      endsAt = new Date(b.endsAt);
      if (isNaN(endsAt.getTime())) return res.status(400).json({ error: 'That end time is not a valid date.' });
      if (endsAt <= startsAt) return res.status(400).json({ error: 'The end time has to be after the start.' });
    }
    const parsed = parseTiers(b.tiers);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const ev = await Event.create({
      hostId: req.userId,
      title,
      description: clean(b.description, 4000),
      coverImage: clean(b.coverImage, 500) || null,
      slug: await makeSlug(title),
      startsAt, endsAt,
      tzOffset: Number.isFinite(Number(b.tzOffset)) ? Number(b.tzOffset) : 0,
      venue: b.venue ? {
        name: clean(b.venue.name, 140) || null, address: clean(b.venue.address, 240) || null,
        city: clean(b.venue.city, 90) || null, region: clean(b.venue.region, 90) || null,
        postal: clean(b.venue.postal, 20) || null, country: clean(b.venue.country, 2).toUpperCase() || null
      } : undefined,
      tiers: parsed.tiers,
      category: ['music', 'nightlife', 'workshop', 'talk', 'sport', 'community', 'online', 'other'].includes(b.category) ? b.category : 'other',
      visibility: b.visibility === 'unlisted' ? 'unlisted' : 'public',
      status: 'draft'
    });

    // Tell the host up front whether they can actually be paid, rather than
    // letting them publish, sell, and then find the money sitting with us.
    const paid = parsed.tiers.some(t => t.priceCents > 0);
    const dest = paid ? await payoutDest(req.userId) : null;
    res.json({
      success: true, event: publicEvent(ev, { host: true }),
      payoutReady: !paid || !!dest,
      payoutWarning: (paid && !dest)
        ? 'Connect a payout account before you publish, or ticket money will be held by Clockwork until you do.'
        : null
    });
  } catch (e) { console.error('event create:', e.message); res.status(500).json({ error: 'Could not create the event' }); }
});

/** Edit, publish or cancel. Host or admin. */
router.patch('/:id', verifyToken, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const ev = await Event.findById(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    if (String(ev.hostId) !== String(req.userId) && !(await isAdmin(req.userId))) {
      return res.status(403).json({ error: 'Only the host can change this event.' });
    }
    const b = req.body || {};
    if (b.title !== undefined) ev.title = clean(b.title, 140) || ev.title;
    if (b.description !== undefined) ev.description = clean(b.description, 4000);
    if (b.coverImage !== undefined) ev.coverImage = clean(b.coverImage, 500) || null;
    if (b.startsAt) { const d = new Date(b.startsAt); if (!isNaN(d.getTime())) ev.startsAt = d; }
    if (b.endsAt !== undefined) {
      if (!b.endsAt) ev.endsAt = null;
      else { const d = new Date(b.endsAt); if (!isNaN(d.getTime()) && d > ev.startsAt) ev.endsAt = d; }
    }
    if (b.tiers) {
      // Editing tiers after sales would orphan tickets whose tierId vanished,
      // and silently change what someone already bought. Price and capacity
      // stay editable; the set of tiers does not.
      const sold = (ev.tiers || []).reduce((n, t) => n + (t.sold || 0), 0);
      if (sold > 0) return res.status(409).json({ error: 'Tickets have already sold — you can no longer change the ticket types.' });
      const parsed = parseTiers(b.tiers);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      ev.tiers = parsed.tiers;
    }
    // Publishing a PAID event with no payout account is the one failure that
    // succeeds silently: Stripe takes the money into the platform balance with
    // no transfer_data, and the host's share sits with Clockwork with no
    // automatic way out. Refusing here is recoverable in two minutes; a
    // fortnight of sales that have to be reconciled by hand is not. Free
    // events publish freely — there is nothing to pay out.
    if (b.status === 'published' && ev.status !== 'published') {
      // A tier priced under the current floor. Events created before the floor
      // moved still carry the old price, and the floor is only checked when
      // tiers are written — so without this a $2 ticket goes on sale, the host
      // receives $0.21 and we take $1.79. The floor exists to prevent exactly
      // that; it has to be enforced where the selling starts, not only where
      // the price is typed.
      const low = (ev.tiers || []).find(t => t.priceCents > 0 && !tickets.priceIsSellable(t.priceCents));
      if (low) {
        return res.status(409).json({
          error: `"${low.name}" is ${tickets.usd(low.priceCents)}, and you would receive ${tickets.usd(tickets.hostPayout(low.priceCents))} of it. Paid tickets start at ${tickets.usd(tickets.MIN_PAID_CENTS)} — or make it free.`,
          needsReprice: true, tierId: low._id, minPaidCents: tickets.MIN_PAID_CENTS
        });
      }
      const paid = (ev.tiers || []).some(t => t.priceCents > 0);
      if (paid && !(await payoutDest(ev.hostId))) {
        return res.status(409).json({
          error: 'Connect a bank account before you sell tickets — otherwise the money has nowhere to land.',
          needsPayout: true
        });
      }
    }
    if (b.status && ['draft', 'published', 'cancelled'].includes(b.status)) ev.status = b.status;
    if (b.visibility && ['public', 'unlisted'].includes(b.visibility)) ev.visibility = b.visibility;
    ev.updatedAt = new Date();
    await ev.save();
    res.json({ success: true, event: publicEvent(ev, { host: true }) });
  } catch (e) { console.error('event patch:', e.message); res.status(500).json({ error: 'Could not update the event' }); }
});

/**
 * Delete an event, for real.
 *
 * ONLY when nothing has been sold. A ticket is a promise to a named person who
 * may have paid; deleting the event behind it would strand a pass that resolves
 * to nothing, with no record of who is owed what. Cancel exists for that case —
 * it keeps the row, keeps the tickets, and tells everyone holding one.
 *
 * So this is the "I made it wrong, start again" button, not an undo for a live
 * event, and it says which one it is when it refuses.
 */
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const ev = await Event.findById(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    if (String(ev.hostId) !== String(req.userId) && !(await isAdmin(req.userId))) {
      return res.status(403).json({ error: 'Only the host can delete this event.' });
    }

    // Count real tickets, not the sold counter: a counter can drift, a Ticket
    // document is somebody holding a pass.
    const issued = await Ticket.countDocuments({ eventId: ev._id, status: { $in: ['valid', 'used'] } });
    if (issued > 0) {
      return res.status(409).json({
        error: `${issued} ${issued === 1 ? 'person has' : 'people have'} a pass to this. Cancel it instead — that keeps their tickets and the record of what they paid.`,
        hasTickets: true, issued
      });
    }

    // The room outlives the event. It is the host's own Studio or channel and
    // may have a history in it; only the back-reference goes.
    if (ev.roomId) {
      try {
        await Conversation.updateOne({ _id: ev.roomId }, { $unset: { event: 1 }, $set: { updatedAt: new Date() } });
      } catch (e) { console.error('[event] detach room on delete:', e.message); }
    }
    // Sweep any refunded/void stragglers so no orphan rows point at a gone event.
    await Ticket.deleteMany({ eventId: ev._id });
    await Event.deleteOne({ _id: ev._id });
    res.json({ success: true, deleted: true, id: ev._id });
  } catch (e) { console.error('event delete:', e.message); res.status(500).json({ error: 'Could not delete the event' }); }
});

/**
 * Attach a Studio or a Messenger channel — the Connect half of an event.
 * Creates one when no roomId is supplied, so a host never has to go and make it
 * separately and come back with an id.
 */
router.post('/:id/room', verifyToken, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const ev = await Event.findById(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    if (String(ev.hostId) !== String(req.userId) && !(await isAdmin(req.userId))) {
      return res.status(403).json({ error: 'Only the host can attach a room.' });
    }
    const b = req.body || {};
    const wantStudio = b.kind !== 'channel';           // 'studio' (default) | 'channel'

    let convo;
    if (b.roomId && mongoose.isValidObjectId(b.roomId)) {
      convo = await Conversation.findOne({ _id: b.roomId, closedAt: null });
      if (!convo) return res.status(404).json({ error: 'That room no longer exists.' });
      if (String(convo.ownerId) !== String(req.userId)) return res.status(403).json({ error: 'You do not host that room.' });
    } else {
      convo = await Conversation.create({
        participants: [req.userId], ownerId: req.userId,
        isRoom: true, isStudio: wantStudio,
        name: clean(ev.title, 80),
        // Invite-only: the room is a hard wall, and a ticket is what opens it.
        visibility: 'invite',
        updatedAt: new Date()
      });
    }
    // Back-reference so the room shows its own doors in Messenger.
    convo.event = { startsAt: ev.startsAt, endsAt: ev.endsAt || null, ticketUrl: eventUrl(ev) };
    await convo.save();

    ev.roomId = convo._id;
    ev.updatedAt = new Date();
    await ev.save();
    res.json({ success: true, roomId: convo._id, isStudio: !!convo.isStudio, event: publicEvent(ev, { host: true }) });
  } catch (e) { console.error('event room:', e.message); res.status(500).json({ error: 'Could not attach a room' }); }
});

/* ───────────────────────────── browse & read ─────────────────────────── */

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 24));
    const q = { status: 'published', visibility: 'public', startsAt: { $gte: new Date(Date.now() - 6 * 3600000) } };
    if (req.query.category) q.category = req.query.category;
    const evs = await Event.find(q).sort({ startsAt: 1 }).limit(limit).lean();
    res.json({ success: true, events: evs.map(e => publicEvent(e)) });
  } catch (e) { console.error('events list:', e.message); res.status(500).json({ error: 'Could not load events' }); }
});

router.get('/mine', verifyToken, async (req, res) => {
  try {
    const evs = await Event.find({ hostId: req.userId }).sort({ startsAt: -1 }).limit(100).lean();
    // A host console is a to-do list, not an archive: the next door to open
    // goes first, then the rest of the calendar, then what already happened —
    // most recent of those first, since that is the one still being settled.
    const cut = Date.now() - 6 * 3600000;
    const upcoming = evs.filter(e => new Date(e.startsAt).getTime() >= cut).sort((a, b) => a.startsAt - b.startsAt);
    const past = evs.filter(e => new Date(e.startsAt).getTime() < cut);   // already newest-first
    // Whether they can be paid, returned with the list rather than left for
    // them to discover when Publish refuses. Nobody should build an event,
    // price it, and only then learn the money has nowhere to go.
    const payout = await payoutStatus(req.userId);
    const payoutReady = payout.state === 'ready';
    // Their handle, so the console can show where published events actually
    // live for everybody else. Cheap here; a second round trip otherwise.
    let handle = null;
    try {
      const me = await User.findById(req.userId).select('handle').lean();
      handle = (me && me.handle) || null;
    } catch (e) { /* the list still stands without it */ }
    res.json({
      success: true,
      payoutReady,
      payout,          // state + what Stripe is still waiting on, in English
      handle,
      // The rate, from the one module that owns it. The create form validates
      // against these numbers, and a form validating against a stale copy of
      // the rate card rejects prices the server would have accepted.
      rate: {
        minPaidCents: tickets.MIN_PAID_CENTS,
        flatCents: tickets.FLAT_CENTS,
        percent: tickets.PERCENT,
        percentAboveCents: tickets.PERCENT_ABOVE_CENTS,
        summary: tickets.rateSummary()
      },
      events: upcoming.concat(past).map(e => publicEvent(e, { host: true }))
    });
  } catch (e) { console.error('events mine:', e.message); res.status(500).json({ error: 'Could not load your events' }); }
});

router.get('/:slugOrId', optionalAuth, async (req, res) => {
  try {
    const key = String(req.params.slugOrId || '');
    const ev = mongoose.isValidObjectId(key)
      ? await Event.findById(key).lean()
      : await Event.findOne({ slug: key.toLowerCase() }).lean();
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    // A draft is invisible to everyone but its host. The host does need to see
    // it: "preview before you publish" is the whole point of a draft, and a
    // 404 on your own event page reads as data loss.
    const mine = req.userId && String(ev.hostId) === String(req.userId);
    if (ev.status === 'draft' && !mine) return res.status(404).json({ error: 'Event not found' });

    // Who is putting this on. A ticket page with no name behind it is how a
    // stranger decides not to buy — and the handle links back to a profile
    // they can actually check.
    let host = null;
    try {
      const h = await User.findById(ev.hostId).select('firstName lastName email handle profilePhoto avatar verified').lean();
      if (h) {
        const nm = [h.firstName, h.lastName].filter(Boolean).join(' ').trim();
        host = {
          id: h._id,
          name: (nm || (h.email ? h.email.split('@')[0] : 'A Clockwork host')).slice(0, 80),
          handle: h.handle || null,
          avatar: h.profilePhoto || h.avatar || null,
          verified: !!h.verified
        };
      }
    } catch (e) { /* the event still stands without it */ }

    res.json({ success: true, event: publicEvent(ev, { host: !!mine }), host, isHost: !!mine });
  } catch (e) { console.error('event get:', e.message); res.status(500).json({ error: 'Could not load the event' }); }
});

module.exports = router;
module.exports.publicEvent = publicEvent;
module.exports.ticketUrl = ticketUrl;
module.exports.payoutDest = payoutDest;

/* ──────────────────────────── buying a ticket ────────────────────────── */

/**
 * Issue a ticket. The one place tickets are minted, so free claims and paid
 * webhooks cannot drift apart.
 *
 * Capacity is enforced with an ATOMIC findOneAndUpdate guarded on sold <
 * capacity. Reading the count and then saving would let two buyers racing for
 * the last seat both pass the check — which is how oversold events happen, and
 * you only find out at the door.
 */
/**
 * Membership IS admission.
 *
 * The room an event creates is invite-only, and invite-only is a hard wall in
 * StudioController — no walk-ins, no knocking, a flat 403. So the only way a
 * ticket opens a Studio is by putting the holder in `participants`. Guarded on
 * $ne so re-running it is free, and never fatal: a room that failed to open is
 * a support ticket, a ticket that failed to issue is a refund.
 */
async function admitToRoom(ev, userId) {
  if (!ev || !ev.roomId || !userId) return false;
  try {
    const r = await Conversation.updateOne(
      { _id: ev.roomId, closedAt: null, participants: { $ne: userId } },
      { $addToSet: { participants: userId }, $set: { updatedAt: new Date() } }
    );
    return !!(r && r.modifiedCount);
  } catch (e) { console.error('[event] room admit failed:', e.message); return false; }
}

/**
 * Tell the host their sales have stopped.
 *
 * Sales stopping silently is how a host finds out on the night. Deduped to one
 * an hour per event and reason, so a queue of blocked buyers does not become a
 * queue of bells — the guard is on the sale, not on the notification, so a
 * missed one costs more than a duplicate.
 */
async function notifyHost(ev, type, text) {
  try {
    const Notification = require('../models/Notification');
    const link = `/events?e=${ev._id}`;
    const since = new Date(Date.now() - 3600000);
    if (await Notification.exists({ userId: ev.hostId, type, link, createdAt: { $gte: since } })) return;
    await Notification.push({ userId: ev.hostId, channel: 'personal', type, text, link });
    require('../services/realtime').userEmit(String(ev.hostId), 'notify', { type, link });
  } catch (e) { console.error('[event] host notify failed:', e.message); }
}

async function issueTicket({ event, tierId, email, name, userId, session }) {
  const tier = (event.tiers || []).id(tierId);
  if (!tier) return { error: 'That ticket type no longer exists.' };

  const claim = tier.capacity == null
    ? { _id: event._id, 'tiers._id': tierId }
    : { _id: event._id, tiers: { $elemMatch: { _id: tierId, sold: { $lt: tier.capacity } } } };

  const taken = await Event.findOneAndUpdate(claim, { $inc: { 'tiers.$.sold': 1 } }, { new: true });
  if (!taken) return { error: 'Sold out.', soldOut: true };

  const price = tier.priceCents;
  try {
    const t = await Ticket.create({
      eventId: event._id, tierId, tierName: tier.name,
      email: String(email || '').toLowerCase().trim(),
      name: clean(name, 120), userId: userId || null,
      code: Ticket.newCode(),
      pricePaidCents: price,
      serviceFeeCents: tickets.serviceFee(price),
      hostPayoutCents: tickets.hostPayout(price),
      // Omit the key entirely for free tickets. Writing null would land inside
      // the unique partial index and the second free ticket would be refused.
      ...(session ? { stripeSessionId: session.id, paymentIntentId: session.payment_intent || null } : {})
    });
    // A ticket to a Clockwork event opens its room. This lives HERE, not only
    // in the paid webhook, because a free RSVP is the commonest Studio event
    // there is — and it was issuing passes that opened nothing.
    await admitToRoom(event, userId);
    return { ticket: t };
  } catch (err) {
    // Duplicate stripeSessionId: Stripe re-delivered a webhook we already
    // handled. Give back the ticket that exists and RELEASE the seat we just
    // claimed, or a retry storm silently eats the venue's capacity.
    if (err.code === 11000 && session) {
      await Event.updateOne({ _id: event._id, 'tiers._id': tierId }, { $inc: { 'tiers.$.sold': -1 } });
      const existing = await Ticket.findOne({ stripeSessionId: session.id });
      if (existing) return { ticket: existing, duplicate: true };
    }
    await Event.updateOne({ _id: event._id, 'tiers._id': tierId }, { $inc: { 'tiers.$.sold': -1 } });
    throw err;
  }
}

/**
 * Buy — or claim, when the tier is free.
 *
 * Free tiers never touch Stripe: the ticket is issued immediately and the URL
 * comes back in the response. Paid tiers return a Stripe Checkout URL, and the
 * ticket is minted by the webhook once payment actually settles.
 *
 * Signing in is optional by design. The email is what the ticket belongs to.
 */
router.post('/:id/checkout', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const ev = await Event.findById(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    if (ev.status !== 'published') return res.status(400).json({ error: 'Tickets are not on sale for this event.' });

    const b = req.body || {};
    const email = String(b.email || '').toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'We need a valid email to send the ticket to.' });
    const tier = (ev.tiers || []).id(b.tierId);
    if (!tier) return res.status(400).json({ error: 'Pick a ticket type.' });
    if (tier.capacity != null && (tier.sold || 0) >= tier.capacity) return res.status(409).json({ error: 'That ticket type is sold out.' });

    // Signed in? Attach the account. Not signed in? The email still works.
    let userId = null;
    try {
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) {
        const jwt = require('jsonwebtoken');
        const d = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
        if (d && d.id) userId = d.id;
      }
    } catch (e) { /* guest checkout is a supported path, not an error */ }

    if (tier.priceCents === 0) {
      const r = await issueTicket({ event: ev, tierId: tier._id, email, name: b.name, userId, session: null });
      if (r.error) return res.status(r.soldOut ? 409 : 400).json({ error: r.error });
      return res.json({
        success: true, free: true,
        ticketUrl: ticketUrl(r.ticket.code), code: r.ticket.code,
        message: 'Your ticket is ready. Save this link — it is your ticket, whether or not the email arrives.'
      });
    }

    // Same guard at the till: an event may have been published before the floor
    // moved, and every sale under it hands the host small change.
    if (!tickets.priceIsSellable(tier.priceCents)) {
      console.error('[event] BLOCKED checkout — tier under the floor:',
        String(ev._id), tier.name, tickets.usd(tier.priceCents));
      await notifyHost(ev, 'event_price_too_low',
        `"${ev.title}" is not selling — ${tier.name} is priced at ${tickets.usd(tier.priceCents)} and you would keep ${tickets.usd(tickets.hostPayout(tier.priceCents))}. Reprice it to ${tickets.usd(tickets.MIN_PAID_CENTS)} or more, or make it free.`);
      return res.status(409).json({ error: 'Ticket sales for this event are paused. The host has been notified.' });
    }

    // Checked again at the till, not just at publish. A Stripe account can be
    // deactivated after an event goes on sale, and taking a stranger's money
    // with no route to the host is worse than a stalled checkout — one is a
    // refund queue, the other is a sale we can honour.
    const dest = await payoutDest(ev.hostId);
    if (!dest) {
      console.error('[event] BLOCKED paid checkout — host has no payout account:', String(ev.hostId), String(ev._id));
      await notifyHost(ev, 'event_payout_blocked',
        `Ticket sales for "${ev.title}" are paused — connect a bank account so the money has somewhere to land.`);
      return res.status(409).json({ error: 'Ticket sales for this event are paused. The host has been notified.' });
    }
    const fee = tickets.serviceFee(tier.priceCents);
    const total = tier.priceCents + fee;   // the fee is added on top, as quoted

    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: total,
          product_data: { name: `${ev.title} — ${tier.name}`, description: `Includes ${tickets.usd(fee)} service fee` }
        }
      }],
      // The host receives their price; Clockwork keeps the fee it quoted.
      ...(dest ? { payment_intent_data: { application_fee_amount: fee, transfer_data: { destination: dest } } } : {}),
      metadata: {
        type: 'event_ticket',
        eventId: String(ev._id), tierId: String(tier._id),
        email, name: clean(b.name, 120), userId: userId ? String(userId) : ''
      },
      success_url: `${SITE}/t/pending?s={CHECKOUT_SESSION_ID}`,
      cancel_url: eventUrl(ev)
    });

    res.json({ success: true, checkoutUrl: session.url, sessionId: session.id });
  } catch (e) { console.error('event checkout:', e.message); res.status(500).json({ error: 'Could not start checkout' }); }
});

/**
 * Called by the verified Stripe webhook in TokenController. Mints the ticket
 * once payment has settled, and admits the buyer to the room when there is one.
 */
async function fulfillTicket(session) {
  const m = session.metadata || {};
  const ev = await Event.findById(m.eventId);
  if (!ev) throw new Error('event gone: ' + m.eventId);

  const r = await issueTicket({
    event: ev, tierId: m.tierId, email: m.email, name: m.name,
    userId: m.userId || null, session
  });
  if (r.error) throw new Error(r.error);
  // Room admission happens inside issueTicket now, so free claims and paid
  // webhooks cannot drift apart. Duplicates already returned the same ticket.
  return r.ticket;
}

/* ─────────────────────── the ticket, and the door ────────────────────── */

/**
 * THE RECOVERY URL. No login, by design.
 *
 * Email delivery fails — spam folders, typos, corporate filters — and a buyer
 * who paid must never be unable to reach what they bought. The code is a bearer
 * token, so this URL is the ticket: openable, screenshotable, forwardable.
 */
router.get('/tickets/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase().trim();
    const t = await Ticket.findOne({ code }).lean();
    if (!t) return res.status(404).json({ error: 'No ticket with that code.' });
    const ev = await Event.findById(t.eventId).lean();

    // The QR is rendered HERE, not in the browser. A ticket whose QR depends on
    // a third-party script is a ticket that fails at the door when a CDN is
    // slow, blocked, or the path is wrong — and the QR is the product. Server
    // SVG means the pass needs nothing but our own response. If even this
    // fails, the printed code below it still gets the holder in.
    let qrSvg = null;
    try {
      qrSvg = await require('qrcode').toString(ticketUrl(t.code), {
        type: 'svg', margin: 1, width: 220,
        color: { dark: '#0b0e14', light: '#ffffff' }
      });
    } catch (e) { console.error('[ticket] qr render failed:', e.message); }

    // Whether the Wallet button can work at all. The page must not render a
    // button that 501s — on a ticket, a control that fails is worse than one
    // that was never there.
    let walletReady = false;
    try { walletReady = require('../services/wallet').available(); } catch (e) {}

    res.json({
      success: true,
      qrSvg,
      walletReady,
      ticket: {
        code: t.code, status: t.status, tierName: t.tierName,
        name: t.name || null, email: t.email,
        scannedAt: t.scannedAt || null,
        pricePaid: t.pricePaidCents ? tickets.usd(t.pricePaidCents) : 'Free',
        url: ticketUrl(t.code),
        createdAt: t.createdAt
      },
      event: ev ? {
        id: ev._id, title: ev.title, startsAt: ev.startsAt, endsAt: ev.endsAt,
        venue: (ev.venue && ev.venue.name) ? ev.venue : null,
        roomId: ev.roomId || null, url: eventUrl(ev),
        cancelled: ev.status === 'cancelled'
      } : null
    });
  } catch (e) { console.error('ticket get:', e.message); res.status(500).json({ error: 'Could not load the ticket' }); }
});

/**
 * Redeem a pass for room access, holding the pass rather than an account
 * history.
 *
 * Buying a ticket does not require signing in — that is deliberate, and it is
 * also why this route has to exist. A guest who buys a pass to an online event
 * has no userId to admit at purchase time, so their pass links to an
 * invite-only room that answers 403. The pass itself is the proof: present a
 * valid code while signed in and the room opens.
 *
 * The code is a bearer instrument, so this also claims the ticket for the
 * account presenting it, and stops accepting a code that has already been
 * scanned or refunded.
 */
router.post('/tickets/:code/room', verifyToken, async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase().trim();
    const t = await Ticket.findOne({ code });
    if (!t) return res.status(404).json({ error: 'No pass with that code.' });
    if (t.status === 'refunded' || t.status === 'void') {
      return res.status(403).json({ error: `That pass was ${t.status}.` });
    }
    const ev = await Event.findById(t.eventId).lean();
    if (!ev) return res.status(404).json({ error: 'That event no longer exists.' });
    if (ev.status === 'cancelled') return res.status(403).json({ error: 'This event was cancelled.' });
    if (!ev.roomId) return res.status(400).json({ error: 'This event has no Clockwork room.' });

    await admitToRoom(ev, req.userId);
    // First account to present an unclaimed pass owns it from here.
    if (!t.userId) { t.userId = req.userId; await t.save(); }

    const convo = await Conversation.findById(ev.roomId).select('isStudio name').lean();
    res.json({
      success: true, roomId: ev.roomId,
      isStudio: !!(convo && convo.isStudio),
      name: (convo && convo.name) || ev.title
    });
  } catch (e) { console.error('ticket room:', e.message); res.status(500).json({ error: 'Could not open the room' }); }
});

/**
 * The same pass, for Apple Wallet.
 *
 * No login: identical reasoning to the recovery URL. Whoever holds the code
 * holds the ticket, and requiring an account to add it to Wallet would put a
 * sign-in between somebody and a door they already paid for.
 *
 * 501 when the signing material is absent, naming what is missing. An
 * unsigned pass is rejected by iOS, so pretending otherwise would produce a
 * button that fails at the worst possible moment.
 */
router.get('/tickets/:code/pass', async (req, res) => {
  try {
    const wallet = require('../services/wallet');
    if (!wallet.available()) {
      return res.status(501).json({
        error: 'Apple Wallet passes are not set up yet.',
        needs: wallet.missing()
      });
    }
    const code = String(req.params.code || '').toUpperCase().trim();
    const t = await Ticket.findOne({ code }).lean();
    if (!t) return res.status(404).json({ error: 'No pass with that code.' });
    if (t.status === 'refunded' || t.status === 'void') {
      return res.status(410).json({ error: `That pass was ${t.status}.` });
    }
    const ev = await Event.findById(t.eventId).lean();
    if (ev && ev.status === 'cancelled') return res.status(410).json({ error: 'This event was cancelled.' });

    let host = null;
    try {
      const h = await User.findById(ev && ev.hostId).select('firstName lastName').lean();
      if (h) host = { name: [h.firstName, h.lastName].filter(Boolean).join(' ').trim() };
    } catch (e) { /* the pass stands without it */ }

    const buf = await wallet.buildTicketPass({ ticket: t, event: ev, ticketUrl: ticketUrl(t.code), host });
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Content-Disposition', `attachment; filename="${t.code}.pkpass"`);
    res.send(buf);
  } catch (e) {
    console.error('wallet pass:', e.message);
    res.status(500).json({ error: 'Could not build the pass' });
  }
});

/** Look up a session after checkout, so the success page can show the ticket. */
router.get('/tickets/by-session/:sessionId', async (req, res) => {
  try {
    const t = await Ticket.findOne({ stripeSessionId: String(req.params.sessionId || '') }).lean();
    // Not an error: the webhook may simply not have landed yet. The client
    // polls, rather than showing someone who just paid a failure screen.
    if (!t) return res.json({ success: true, pending: true });
    res.json({ success: true, pending: false, code: t.code, ticketUrl: ticketUrl(t.code) });
  } catch (e) { console.error('ticket by session:', e.message); res.status(500).json({ error: 'Lookup failed' }); }
});

/**
 * The door. Host or admin only.
 *
 * Atomic: the status flips from valid to used in ONE guarded update. Two
 * doormen scanning the same QR at the same instant must not both be told
 * "valid" — the second gets "already used", with the time it was first scanned.
 */
router.post('/tickets/:code/scan', verifyToken, async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase().trim();
    const t = await Ticket.findOne({ code });
    if (!t) return res.status(404).json({ ok: false, reason: 'not_found', error: 'No ticket with that code.' });
    const ev = await Event.findById(t.eventId).lean();
    if (!ev) return res.status(404).json({ ok: false, reason: 'not_found', error: 'That event no longer exists.' });
    if (String(ev.hostId) !== String(req.userId) && !(await isAdmin(req.userId))) {
      return res.status(403).json({ ok: false, reason: 'forbidden', error: 'Only the host can scan tickets.' });
    }
    if (ev.status === 'cancelled') return res.json({ ok: false, reason: 'cancelled', error: 'This event was cancelled.' });
    if (t.status === 'refunded' || t.status === 'void') {
      return res.json({ ok: false, reason: t.status, error: `That ticket was ${t.status}.` });
    }

    const claimed = await Ticket.findOneAndUpdate(
      { _id: t._id, status: 'valid' },
      { $set: { status: 'used', scannedAt: new Date(), scannedBy: req.userId } },
      { new: true }
    );
    if (!claimed) {
      const now = await Ticket.findById(t._id).lean();
      return res.json({
        ok: false, reason: 'already_used',
        error: 'Already scanned.',
        scannedAt: now && now.scannedAt,
        holder: { name: t.name || null, email: t.email, tier: t.tierName }
      });
    }
    res.json({
      ok: true, code: claimed.code, tier: claimed.tierName,
      holder: { name: claimed.name || null, email: claimed.email },
      event: { title: ev.title, startsAt: ev.startsAt }
    });
  } catch (e) { console.error('ticket scan:', e.message); res.status(500).json({ ok: false, error: 'Scan failed' }); }
});

/** Guest list — host or admin. */
router.get('/:id/attendees', verifyToken, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const ev = await Event.findById(req.params.id).lean();
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    if (String(ev.hostId) !== String(req.userId) && !(await isAdmin(req.userId))) {
      return res.status(403).json({ error: 'Only the host can see the guest list.' });
    }
    const list = await Ticket.find({ eventId: ev._id }).sort({ createdAt: -1 }).limit(2000).lean();
    res.json({
      success: true,
      counts: {
        sold: list.length,
        checkedIn: list.filter(t => t.status === 'used').length,
        refunded: list.filter(t => t.status === 'refunded').length
      },
      grossCents: list.reduce((n, t) => n + (t.pricePaidCents || 0), 0),
      payoutCents: list.reduce((n, t) => n + (t.hostPayoutCents || 0), 0),
      attendees: list.map(t => ({
        code: t.code, name: t.name || null, email: t.email, tier: t.tierName,
        status: t.status, scannedAt: t.scannedAt || null, at: t.createdAt
      }))
    });
  } catch (e) { console.error('attendees:', e.message); res.status(500).json({ error: 'Could not load the guest list' }); }
});

module.exports.fulfillTicket = fulfillTicket;
module.exports.issueTicket = issueTicket;
