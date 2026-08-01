/**
 * Event — anything a member sells tickets to.
 *
 * Deliberately NOT a field on Conversation. A room that has a start time is one
 * kind of event; a warehouse show, a workshop, a dinner is another, and it has
 * an address rather than a Studio. Modelling the event on the room would have
 * made every real-world event carry a room it does not want, so the room is the
 * optional part:
 *
 *   venue set, no roomId   → a real-life event
 *   roomId set, no venue   → a Clockwork event, in a Studio
 *   both                   → a physical show with a livestream room
 *
 * Money moves on the Stripe Connect rail the paid-room door already uses: the
 * host's Express account receives, Clockwork takes an application fee. Nothing
 * new to build there — see services/ticketing for the rate.
 */
const mongoose = require('mongoose');

// One purchasable class of ticket. Kept inline rather than in its own
// collection: tiers are meaningless without their event, are read on every
// event view, and never number more than a handful.
const tierSchema = new mongoose.Schema({
  name: { type: String, trim: true, maxlength: 60, required: true },
  priceCents: { type: Number, min: 0, max: 10000000, default: 0 },
  // null = unlimited. 0 would be indistinguishable from "sold out" and is a
  // genuinely different thing to say.
  capacity: { type: Number, min: 1, max: 1000000, default: null },
  // Denormalized so a sold-out check does not count the Ticket collection on
  // every page view. Incremented atomically at issue time; the Ticket documents
  // remain the source of truth if the two ever disagree.
  sold: { type: Number, default: 0, min: 0 },
  description: { type: String, trim: true, maxlength: 200 }
}, { _id: true });

const eventSchema = new mongoose.Schema({
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, trim: true, maxlength: 140, required: true },
  description: { type: String, trim: true, maxlength: 4000 },
  coverImage: { type: String, trim: true, maxlength: 500, default: null },

  // Public URL: theclockworkhub.com/e/<slug>. Unique so a link never becomes
  // ambiguous once it is out in the world on a poster.
  slug: { type: String, trim: true, lowercase: true, unique: true, sparse: true, maxlength: 90 },

  startsAt: { type: Date, required: true, index: true },
  endsAt: { type: Date, default: null },
  // Host's UTC offset at creation. Stored because "doors at 8" means 8 where
  // the event IS — a Sarasota show does not move because a buyer is in Berlin.
  tzOffset: { type: Number, default: 0 },

  // Real-world location. Absent for online-only events.
  venue: {
    name: { type: String, trim: true, maxlength: 140, default: null },
    address: { type: String, trim: true, maxlength: 240, default: null },
    city: { type: String, trim: true, maxlength: 90, default: null },
    region: { type: String, trim: true, maxlength: 90, default: null },
    postal: { type: String, trim: true, maxlength: 20, default: null },
    country: { type: String, trim: true, maxlength: 2, default: null }
  },
  // A Clockwork event happens in a room. Ticket holders get admitted to it —
  // invite-only is already a hard wall, so a ticket becomes another way in.
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null, index: true },

  tiers: { type: [tierSchema], default: [] },

  // draft never appears publicly; cancelled stays visible so ticket holders can
  // still find it and see what happened, rather than the page vanishing.
  status: { type: String, enum: ['draft', 'published', 'cancelled'], default: 'draft', index: true },
  visibility: { type: String, enum: ['public', 'unlisted'], default: 'public' },
  category: { type: String, enum: ['music', 'nightlife', 'workshop', 'talk', 'sport', 'community', 'online', 'other'], default: 'other' },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// The public browse query: published, public, still upcoming.
eventSchema.index({ status: 1, visibility: 1, startsAt: 1 });

/** Total tickets sold across all tiers. */
eventSchema.virtual('soldTotal').get(function () {
  return (this.tiers || []).reduce((n, t) => n + (t.sold || 0), 0);
});

/** True when every tier with a capacity is full (and at least one exists). */
eventSchema.methods.isSoldOut = function () {
  const tiers = this.tiers || [];
  if (!tiers.length) return false;
  return tiers.every(t => t.capacity != null && (t.sold || 0) >= t.capacity);
};

/** Seats left on a tier — Infinity when uncapped. */
eventSchema.methods.remaining = function (tierId) {
  const t = (this.tiers || []).id(tierId);
  if (!t) return 0;
  if (t.capacity == null) return Infinity;
  return Math.max(0, t.capacity - (t.sold || 0));
};

module.exports = mongoose.models.Event || mongoose.model('Event', eventSchema);
