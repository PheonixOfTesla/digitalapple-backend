/**
 * StudioController — Clockwork Studios.
 *
 * A Studio is a live connect room: a chat channel, voice + screen share (over the
 * /studio Socket.IO namespace), and a blueprint the host builds together with
 * whoever joins. It's a Conversation with isStudio=true, so the persistent chat
 * reuses /messages/conversations/:id/messages and the member list is participants.
 *
 *   POST /studios                 create a Studio (host = you) { name, guestIds? }
 *   GET  /studios/:id             studio details (members, host, blueprint link)
 *   POST /studios/:id/join        join by link (adds you to the room)
 *   POST /studios/:id/blueprint   host: create + attach a blueprint to the room
 */
const express = require('express');
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const Project = require('../models/Project');
const Notification = require('../models/Notification');
const realtime = require('../services/realtime');
const { verifyToken } = require('../middleware/auth');
const { roomOpenNow, hoursPublic, noticeOf, eventPublic } = require('../utils/roomHours');

const router = express.Router();

// ── Public routes (no sign-in) — mounted BEFORE the auth wall ────────────────

// Who's live right now — socket headcount per studio, for LIVE pills.
router.get('/live', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(id => mongoose.isValidObjectId(id)).slice(0, 40);
  res.json({ success: true, live: realtime.liveStudioCounts(ids) });
});

// Browse public rooms without signing in — the Connect arrival shows real
// doors: who's live, how many belong, what entry costs.
router.get('/discover', async (req, res) => {
  try {
    const rooms = await Conversation.find({ isRoom: true, visibility: 'public', closedAt: null })
      .sort({ updatedAt: -1 }).limit(24).select('name photo price hours participants category description').lean();
    const live = realtime.liveStudioCounts(rooms.map(r => String(r._id)));
    res.json({ success: true, rooms: rooms.map(r => ({
      id: r._id, name: r.name || 'Room', photo: r.photo || null,
      // The purpose — what the room is for — so the floor reads like a directory,
      // not a list of names. Front end shows it under the title.
      purpose: (r.description || '').trim(),
      price: r.price || 0, openNow: roomOpenNow(r), notice: noticeOf(r),
      category: r.category || 'other',
      members: (r.participants || []).length, live: (live && live[String(r._id)]) || 0
    })) });
  } catch (e) { console.error('discover:', e.message); res.status(500).json({ error: 'Failed' }); }
});

// Just enough about a studio to render the door: name + public/private.
router.get('/:id/public', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const c = await Conversation.findOne({ _id: req.params.id, closedAt: null }).select('name visibility isStudio isRoom photo hours price').lean();
    if (!c || (!c.isStudio && !c.isRoom)) return res.status(404).json({ error: 'Studio not found' });
    res.json({ success: true, studio: { id: c._id, name: c.name || 'Studio', visibility: c.visibility || 'private', photo: c.photo || null, openNow: roomOpenNow(c), hours: hoursPublic(c), price: c.price || 0, event: eventPublic(c) } });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// Guest pass: a name is enough to walk into a PUBLIC studio. The pass is a
// short-lived token scoped to this one room — no account, no other access.
router.post('/:id/guest', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const name = clampStr((req.body || {}).name, 60);
    if (!name) return res.status(400).json({ error: 'Tell us your name first.' });
    // Anonymous guests are PUBLIC-only — private rooms take sign-in + knock.
    const c = await Conversation.findOne({ _id: req.params.id, closedAt: null }).select('visibility isStudio isRoom name hours price').lean();
    if (!c || (!c.isStudio && !c.isRoom)) return res.status(404).json({ error: 'Studio not found' });
    if (c.visibility !== 'public') return res.status(403).json({ error: 'This room is private — sign in and knock.' });
    if (noticeOf(c) > 0) return res.status(403).json({ error: 'This room takes visits by advance request — sign in and ask about ' + noticeOf(c) + ' hours ahead.', hours: hoursPublic(c) });
    if ((c.price || 0) > 0) return res.status(403).json({ error: 'This room has paid entry — sign in to buy your spot.', price: c.price });
    if (!roomOpenNow(c)) return res.status(403).json({ error: 'Outside business hours — come back when the room opens.', hours: hoursPublic(c) });
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ guest: true, studioId: String(c._id), name }, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, token, name, studio: { id: c._id, name: c.name || 'Studio' } });
  } catch (e) { console.error('guest pass:', e.message); res.status(500).json({ error: 'Could not create guest pass' }); }
});

router.use(verifyToken);

function nameOf(u) {
  if (!u) return 'Member';
  const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return (nm || (u.email ? u.email.split('@')[0] : 'Member')).slice(0, 80);
}
function clampStr(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

// Server-side role check — the client's isAdmin flag is never trusted.
async function isAdminUser(userId) {
  try {
    const u = await User.findById(userId).select('role').lean();
    return !!(u && u.role === 'admin');
  } catch (e) { return false; }
}

// Where a room's entry fee lands: the host's Express account when it can take
// transfers (Clockwork keeps 10%), otherwise the platform account.
const PLATFORM_FEE = 0.10;
async function payoutDest(convo) {
  try {
    const host = await User.findById(convo.ownerId).select('stripeAccountId').lean();
    if (!host || !host.stripeAccountId) return null;
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    const acct = await stripe.accounts.retrieve(host.stripeAccountId);
    if (acct && acct.capabilities && acct.capabilities.transfers === 'active') return host.stripeAccountId;
  } catch (e) { /* fall back to platform */ }
  return null;
}
function feeFor(price) { return Math.max(1, Math.round(price * PLATFORM_FEE)); }

async function members(convo) {
  const users = await User.find({ _id: { $in: convo.participants } })
    .select('firstName lastName email profilePhotoThumb profilePhoto verified').lean();
  const roleOf = {};
  (convo.memberRoles || []).forEach(r => { if (r.userId) roleOf[String(r.userId)] = r.role || ''; });
  return users.map(u => ({
    id: u._id, name: nameOf(u), avatar: u.profilePhotoThumb || u.profilePhoto || null,
    verified: !!u.verified, isHost: String(u._id) === String(convo.ownerId),
    role: roleOf[String(u._id)] || ''
  }));
}

// ── Create a Studio ───────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    // A host runs up to 3 active Connect rooms at once (admins exempt).
    const owned = await Conversation.countDocuments({ ownerId: req.userId, closedAt: null, $or: [{ isRoom: true }, { isStudio: true }] });
    if (owned >= 3 && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'You host 3 Connect rooms already — delete one to open another.' });
    }
    const name = clampStr(b.name, 80) || 'Studio';
    const guests = Array.isArray(b.guestIds) ? b.guestIds.filter(id => mongoose.isValidObjectId(id)) : [];
    const participants = Array.from(new Set([String(req.userId), ...guests.map(String)]));
    const convo = await Conversation.create({
      participants, isRoom: true, isStudio: true, name,
      ownerId: req.userId, visibility: b.visibility === 'public' ? 'public' : 'private',
      category: 'ideas', updatedAt: new Date()
    });
    res.json({ success: true, id: convo._id, name: convo.name });
  } catch (e) { console.error('studio create:', e.message); res.status(500).json({ error: 'Could not create studio' }); }
});

// ── Studio details ────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    // Every room has a Studio inside — Connect rooms (isRoom) open here too.
    const convo = await Conversation.findOne({ _id: req.params.id, $or: [{ isStudio: true }, { isRoom: true }] });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    const isMember = (convo.participants || []).some(id => String(id) === String(req.userId));
    if (!isMember && convo.visibility !== 'public') {
      // Tell a knocking guest their request is still pending so the client can
      // show a waiting state instead of a hard wall.
      const pending = (convo.joinRequests || []).some(r => String(r.userId) === String(req.userId));
      return res.status(403).json({ error: 'Private studio', pending });
    }

    let blueprint = null;
    if (convo.blueprintProjectId) {
      const p = await Project.findById(convo.blueprintProjectId).select('name').lean();
      if (p) blueprint = { id: p._id, name: p.name };
    }
    const isHost = String(convo.ownerId) === String(req.userId);
    // Pending knocks — host (or admin) only, with names for the accept UI.
    let requests = [];
    if ((isHost || await isAdminUser(req.userId)) && (convo.joinRequests || []).length) {
      const ids = convo.joinRequests.map(r => r.userId);
      const users = await User.find({ _id: { $in: ids } }).select('firstName lastName email profilePhotoThumb profilePhoto').lean();
      requests = users.map(u => {
        const e = (convo.joinRequests || []).find(r => String(r.userId) === String(u._id));
        return { id: u._id, name: nameOf(u), avatar: u.profilePhotoThumb || u.profilePhoto || null, paid: !!(e && e.paid) };
      });
    }
    res.json({
      success: true,
      studio: {
        id: convo._id, name: convo.name, hostId: convo.ownerId,
        isHost, isMember, visibility: convo.visibility, blueprint,
        event: eventPublic(convo),
        members: await members(convo), requests
      }
    });
  } catch (e) { console.error('studio get:', e.message); res.status(500).json({ error: 'Failed to load studio' }); }
});

// ── Join by link ──────────────────────────────────────────────────────────────
// Public studios: free access — you're in. Private studios: knock-to-enter —
// your request queues as pending and the host gets a notification; you're only
// added once they accept.
router.post('/:id/join', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    // Connect rooms (isRoom) are joinable Studios too — same public/knock rules.
    const convo = await Conversation.findOne({ _id: req.params.id, $or: [{ isStudio: true }, { isRoom: true }], closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    if ((convo.participants || []).some(id => String(id) === String(req.userId))) {
      return res.json({ success: true, id: convo._id, name: convo.name, member: true });
    }
    // Invite-only is a true wall: no walk-ins, no knocking. The only way in
    // is the host's invite (POST /:id/invite adds membership directly).
    if (convo.visibility === 'invite') {
      return res.status(403).json({ error: 'Invite only — the host sends the invites here.', inviteOnly: true });
    }
    // Advance-notice rooms take no walk-ins even when public: the ask below
    // queues as a join request the host answers on their own schedule.
    if (convo.visibility === 'public' && noticeOf(convo) === 0) {
      if (!roomOpenNow(convo)) return res.status(403).json({ error: 'Outside business hours — come back when the room opens.', hours: hoursPublic(convo) });
      // Paid rooms: the door is a Stripe checkout — the verified webhook
      // (metadata type room_entry) makes them a member once payment lands.
      if ((convo.price || 0) > 0) {
        const Stripe = require('stripe');
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
        const dest = await payoutDest(convo);
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          success_url: `${process.env.FRONTEND_URL}/studio.html?id=${convo._id}&paid=1`,
          cancel_url: `${process.env.FRONTEND_URL}/studio.html?id=${convo._id}`,
          line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Entry — ' + (convo.name || 'Studio') }, unit_amount: convo.price }, quantity: 1 }],
          ...(dest ? { payment_intent_data: { application_fee_amount: feeFor(convo.price), transfer_data: { destination: dest } } } : {}),
          metadata: { type: 'room_entry', roomId: String(convo._id), userId: String(req.userId) }
        });
        return res.json({ success: true, payRequired: true, url: session.url, amount: convo.price });
      }
      convo.participants.push(req.userId); convo.updatedAt = new Date(); await convo.save();
      return res.json({ success: true, id: convo._id, name: convo.name, member: true });
    }
    // Private — queue the knock (once) and tell the host.
    const alreadyAsked = (convo.joinRequests || []).some(r => String(r.userId) === String(req.userId));
    // Paid-then-accepted: on a paid room the request only files once payment
    // lands (webhook type room_request). A declined paid request refunds.
    if (!alreadyAsked && (convo.price || 0) > 0) {
      const Stripe = require('stripe');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
      const dest = await payoutDest(convo);
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: `${process.env.FRONTEND_URL}/studio.html?id=${convo._id}&requested=1`,
        cancel_url: `${process.env.FRONTEND_URL}/studio.html?id=${convo._id}`,
        line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Entry request — ' + (convo.name || 'Studio') }, unit_amount: convo.price }, quantity: 1 }],
        ...(dest ? { payment_intent_data: { application_fee_amount: feeFor(convo.price), transfer_data: { destination: dest } } } : {}),
        metadata: { type: 'room_request', roomId: String(convo._id), userId: String(req.userId) }
      });
      return res.json({ success: true, payRequired: true, url: session.url, amount: convo.price, request: true });
    }
    if (!alreadyAsked) {
      convo.joinRequests.push({ userId: req.userId, at: new Date() });
      await convo.save();
      try {
        const me = await User.findById(req.userId).select('firstName lastName email').lean();
        const link = 'studio.html?id=' + String(convo._id);
        const text = nameOf(me) + ' wants to join "' + (convo.name || 'your Studio') + '"';
        const already = await Notification.findOne({ userId: convo.ownerId, type: 'join_request', actorId: req.userId, read: false, link }).select('_id').lean();
        if (!already) await Notification.push({ userId: convo.ownerId, channel: 'personal', type: 'join_request', actorId: req.userId, actorName: nameOf(me), text, link });
        realtime.userEmit(convo.ownerId, 'notify', { type: 'join_request', text, link });
      } catch (e) { /* non-fatal */ }
    }
    res.json({ success: true, pending: true, id: convo._id, name: convo.name });
  } catch (e) { console.error('studio join:', e.message); res.status(500).json({ error: 'Could not join' }); }
});

// Invite someone — plain, or "come at this time". Host (or admin) only. The
// invitee becomes a member right away; the bell carries the when.
router.post('/:id/invite', async (req, res) => {
  try {
    const b = req.body || {};
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(b.userId)) return res.status(400).json({ error: 'Bad id' });
    const convo = await Conversation.findOne({ _id: req.params.id, $or: [{ isStudio: true }, { isRoom: true }], closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) return res.status(403).json({ error: 'Only the host can invite.' });
    const target = await User.findById(b.userId).select('_id').lean();
    if (!target) return res.status(404).json({ error: 'No Clockwork Hub found for that person.' });
    if (!(convo.participants || []).some(id => String(id) === String(b.userId))) {
      convo.participants.push(b.userId); convo.updatedAt = new Date(); await convo.save();
    }
    const me = await User.findById(req.userId).select('firstName lastName email').lean();
    const when = clampStr(b.atLabel, 60);
    const link = 'studio.html?id=' + String(convo._id);
    const text = nameOf(me) + ' invited you to "' + (convo.name || 'a Studio') + '"' + (when ? (' — ' + when) : '');
    try {
      await Notification.push({ userId: b.userId, channel: 'personal', type: 'studio_invite', actorId: req.userId, actorName: nameOf(me), text, link });
      realtime.userEmit(b.userId, 'notify', { type: 'studio_invite', text, link });
    } catch (e) { /* non-fatal */ }
    res.json({ success: true, when: when || null });
  } catch (e) { console.error('studio invite:', e.message); res.status(500).json({ error: 'Could not invite' }); }
});

// ── Host (or admin) accepts / declines a pending join request ────────────────
router.post('/:id/requests/:userId/:action', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ error: 'Bad id' });
    }
    if (req.params.action !== 'accept' && req.params.action !== 'decline') {
      return res.status(400).json({ error: 'Bad action' });
    }
    // Requests live on rooms and Studios alike.
    const convo = await Conversation.findOne({ _id: req.params.id, $or: [{ isStudio: true }, { isRoom: true }], closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'Only the host can manage requests' });
    }
    const uid = req.params.userId;
    const entry = (convo.joinRequests || []).find(r => String(r.userId) === String(uid));
    const had = !!entry;
    convo.joinRequests = (convo.joinRequests || []).filter(r => String(r.userId) !== String(uid));
    if (req.params.action === 'accept' && had) {
      if (!(convo.participants || []).some(id => String(id) === String(uid))) convo.participants.push(uid);
      convo.updatedAt = new Date();
      await convo.save();
      try {
        const link = 'studio.html?id=' + String(convo._id);
        await Notification.push({
          userId: uid, channel: 'personal', type: 'join_accepted', actorId: req.userId,
          text: 'You’re in — "' + (convo.name || 'Studio') + '" accepted your request', link
        });
        realtime.userEmit(uid, 'notify', { type: 'join_accepted', link });
      } catch (e) { /* non-fatal */ }
      return res.json({ success: true, accepted: true });
    }
    await convo.save();
    // Declining a PAID request refunds the payment in full — automatically.
    if (had && entry && entry.paid && entry.paymentIntent) {
      try {
        const Stripe = require('stripe');
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
        // Destination charges (host payouts) refund with the transfer pulled
        // back and the platform fee returned — the payer is made whole.
        const opts = { payment_intent: entry.paymentIntent };
        try {
          const pi = await stripe.paymentIntents.retrieve(entry.paymentIntent);
          if (pi && pi.transfer_data) { opts.reverse_transfer = true; opts.refund_application_fee = true; }
        } catch (e) { /* plain refund */ }
        await stripe.refunds.create(opts);
        try {
          await Notification.push({
            userId: uid, channel: 'personal', type: 'join_declined', actorId: req.userId,
            text: '"' + (convo.name || 'Studio') + '" declined your request — your payment was refunded',
            link: 'connect.html'
          });
          realtime.userEmit(uid, 'notify', { type: 'join_declined', link: 'connect.html' });
        } catch (e) { /* non-fatal */ }
      } catch (e) { console.error('refund on decline:', e.message); }
    }
    res.json({ success: true, declined: true });
  } catch (e) { console.error('studio request:', e.message); res.status(500).json({ error: 'Could not update request' }); }
});

// ── Host (or admin) flips the room public/private ────────────────────────────
// Public: anyone with the link walks straight in. Private: they knock and wait.
router.post('/:id/visibility', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const vis = (req.body || {}).visibility === 'public' ? 'public' : 'private';
    const convo = await Conversation.findOne({ _id: req.params.id, isStudio: true, closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'Only the host can change this' });
    }
    convo.visibility = vis;
    convo.updatedAt = new Date();
    await convo.save();
    res.json({ success: true, visibility: vis });
  } catch (e) { console.error('studio visibility:', e.message); res.status(500).json({ error: 'Could not update' }); }
});

// ── Host (or admin) assigns a member a role label (Co-host, Builder, …) ──────
router.post('/:id/role', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const b = req.body || {};
    if (!mongoose.isValidObjectId(b.userId)) return res.status(400).json({ error: 'Bad member id' });
    const role = clampStr(b.role, 24); // empty string clears the role
    // Connect rooms are Studios too — roles (and share rights) work in both.
    const convo = await Conversation.findOne({ _id: req.params.id, $or: [{ isStudio: true }, { isRoom: true }], closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'Only the host can assign roles' });
    }
    if (!(convo.participants || []).some(id => String(id) === String(b.userId))) {
      return res.status(400).json({ error: 'Not a member of this Studio' });
    }
    convo.memberRoles = (convo.memberRoles || []).filter(r => String(r.userId) !== String(b.userId));
    if (role) convo.memberRoles.push({ userId: b.userId, role });
    convo.updatedAt = new Date();
    await convo.save();
    // A granted role rings the member's bell — hosting gets its own words.
    if (role) {
      try {
        const me = await User.findById(req.userId).select('firstName lastName email').lean();
        const link = 'studio.html?id=' + String(convo._id);
        const text = /host/i.test(role)
          ? nameOf(me) + ' granted you hosting in "' + (convo.name || 'a Studio') + '" — you can run the stage'
          : nameOf(me) + ' made you ' + role + ' in "' + (convo.name || 'a Studio') + '"';
        await Notification.push({ userId: b.userId, channel: 'personal', type: 'studio_role', actorId: req.userId, actorName: nameOf(me), text, link });
        realtime.userEmit(b.userId, 'notify', { type: 'studio_role', text, link });
      } catch (e) { /* non-fatal */ }
    }
    res.json({ success: true, role });
  } catch (e) { console.error('studio role:', e.message); res.status(500).json({ error: 'Could not assign role' }); }
});

// Host (or admin) removes a member — out of the room's membership entirely.
// A private room then takes a fresh knock to get back in.
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.userId)) return res.status(400).json({ error: 'Bad id' });
    const convo = await Conversation.findOne({ _id: req.params.id, $or: [{ isStudio: true }, { isRoom: true }], closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) return res.status(403).json({ error: 'Only the host can remove members' });
    if (String(convo.ownerId) === String(req.params.userId)) return res.status(400).json({ error: 'The host stays' });
    convo.participants = (convo.participants || []).filter(id => String(id) !== String(req.params.userId));
    convo.memberRoles = (convo.memberRoles || []).filter(r => String(r.userId) !== String(req.params.userId));
    convo.joinRequests = (convo.joinRequests || []).filter(r => String(r.userId) !== String(req.params.userId));
    convo.updatedAt = new Date();
    await convo.save();
    res.json({ success: true });
  } catch (e) { console.error('studio kick:', e.message); res.status(500).json({ error: 'Could not remove member' }); }
});

// ── Host creates + attaches a blueprint to the Studio ─────────────────────────
router.post('/:id/blueprint', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const convo = await Conversation.findOne({ _id: req.params.id, isStudio: true });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    if (String(convo.ownerId) !== String(req.userId)) return res.status(403).json({ error: 'Only the host can start the blueprint' });

    // Import an EXISTING blueprint: host passes projectId of a project they own.
    const importId = (req.body || {}).projectId;
    if (importId && mongoose.isValidObjectId(importId)) {
      const own = await Project.findOne({ _id: importId, ownerId: req.userId }).select('name').lean();
      if (!own) return res.status(404).json({ error: 'Blueprint not found' });
      convo.blueprintProjectId = own._id; convo.updatedAt = new Date(); await convo.save();
      return res.json({ success: true, projectId: own._id, name: own.name, imported: true });
    }
    // Reuse an already-attached blueprint if present.
    if (convo.blueprintProjectId) {
      const existing = await Project.findById(convo.blueprintProjectId).select('name').lean();
      if (existing) return res.json({ success: true, projectId: existing._id, name: existing.name });
    }
    const name = clampStr((req.body || {}).name, 120) || (convo.name + ' — blueprint');
    const project = await Project.create({ name, ownerId: req.userId });
    convo.blueprintProjectId = project._id; convo.updatedAt = new Date(); await convo.save();
    res.json({ success: true, projectId: project._id, name: project.name });
  } catch (e) { console.error('studio blueprint:', e.message); res.status(500).json({ error: 'Could not start blueprint' }); }
});

module.exports = router;
