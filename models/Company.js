const mongoose = require('mongoose');

/**
 * Company — a directory entry (company-first; products live underneath).
 *
 * Ranking is a single blended score across every source we have for the company:
 *   ratings.clockwork  — our own signed-in, moderated reviews (the backbone)
 *   ratings.google     — optional, via Google Places API (needs Place ID + key)
 *   ratings.yelp       — optional, via Yelp Fusion API (needs Biz ID + key)
 * aggregateScore = volume-weighted mean across whichever sources are present.
 * rankScore      = Bayesian-adjusted (small samples pulled toward a prior) — the
 *                  value we SORT by, so one 5★ review can't top 200 reviews at 4.6.
 * External sources are enrichment only; Clockwork reviews always count.
 */

const sourceRating = {
  avg: { type: Number, default: 0, min: 0, max: 5 },
  count: { type: Number, default: 0, min: 0 },
  url: { type: String, trim: true },        // link back (required by Google/Yelp ToS)
  externalId: { type: String, trim: true }, // Google Place ID / Yelp Business ID
  syncedAt: { type: Date }
};

const companySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  tagline: { type: String, trim: true, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 2000 },
  website: { type: String, trim: true, maxlength: 300 },
  logo: { type: String },                    // Cloudinary URL
  category: { type: String, trim: true, maxlength: 60, default: 'other' },

  // The directory's differentiators (see CLAUDE.md)
  deployment: { type: String, enum: ['cloud', 'local', 'self-hosted', 'hybrid', 'unknown'], default: 'unknown' },
  dataPolicy: { type: String, trim: true, maxlength: 600 }, // plain-language privacy

  // Products underneath the company (company-first layout)
  products: [{
    name: { type: String, trim: true, maxlength: 100 },
    tagline: { type: String, trim: true, maxlength: 160 },
    link: { type: String, trim: true, maxlength: 300 }
  }],

  // Legal-registration gate — only legally registered businesses get listed. The
  // company stays pending + unverified until this is confirmed (admin, or an
  // external registry lookup like OpenCorporates). A hard gate keeps the atlas real.
  legal: {
    registeredName: { type: String, trim: true, maxlength: 160 },
    registrationNumber: { type: String, trim: true, maxlength: 60 }, // company no. / EIN
    entityType: { type: String, trim: true, maxlength: 60 },         // LLC, Inc, Ltd…
    jurisdiction: { type: String, trim: true, maxlength: 100 },      // state/country of registration
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date },
    verificationSource: { type: String, trim: true, maxlength: 120 } // 'admin' | 'opencorporates' | …
  },

  // Adoption / partnership — a company that uses Blueprint ranks higher on the
  // Company Atlas (the "sell Blueprint to companies" flywheel). Kept SEPARATE from
  // the honest review score: reviews set rankScore; these only add a sort boost.
  usesBlueprint: { type: Boolean, default: false },
  partner: { type: Boolean, default: false },
  whyUseThem: { type: String, trim: true, maxlength: 600 }, // the company's own case

  // Optional location — powers the zip-code Spotlight (visitor location via ipapi).
  location: {
    city: { type: String, trim: true, maxlength: 80 },
    region: { type: String, trim: true, maxlength: 80 },        // state/province name
    regionCode: { type: String, trim: true, maxlength: 12 },    // e.g. "FL"
    country: { type: String, trim: true, maxlength: 60 },
    countryCode: { type: String, trim: true, maxlength: 4 },
    postal: { type: String, trim: true, maxlength: 16 }
  },

  // Blended ranking across sources
  ratings: {
    clockwork: { type: sourceRating, default: () => ({}) },
    google: { type: sourceRating, default: () => ({}) },
    yelp: { type: sourceRating, default: () => ({}) }
  },
  aggregateScore: { type: Number, default: 0 },  // plain volume-weighted mean (display)
  aggregateCount: { type: Number, default: 0 },  // total reviews across all sources
  rankScore: { type: Number, default: 0 },       // Bayesian-adjusted honest review score
  sortScore: { type: Number, default: 0 },       // rankScore + adoption/verified/feature boost (sort key)

  featured: { type: Boolean, default: false },   // admin spotlight pin

  // Clockwork editorial — an openly-attributed house assessment (NOT a user
  // review; never counted in ratings). Rendered with its byline and date so
  // readers know exactly whose voice it is. Real user reviews + linked
  // external sources (Trustpilot by domain) carry the credibility.
  editorial: {
    take: { type: String, trim: true, maxlength: 900 },
    byline: { type: String, trim: true, maxlength: 80, default: 'Clockwork editorial' },
    updatedAt: { type: Date }
  },

  // Moderation — user-generated, admin-approved
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  submittedName: { type: String, trim: true, maxlength: 80 },

  // Provenance. 'user' = submitted via the form; 'wikidata' = aggregated from the
  // public knowledge base (real, registered entities — but legal.verified stays
  // false until confirmed, and no reviews are invented).
  source: { type: String, default: 'user' },
  wikidataId: { type: String, trim: true, index: true, sparse: true }, // e.g. "Q95" — dedupe key for aggregation

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  approvedAt: { type: Date }
});

// Search + ranking indexes
companySchema.index({ name: 'text', tagline: 'text', description: 'text' });
companySchema.index({ status: 1, sortScore: -1 });
companySchema.index({ status: 1, 'location.regionCode': 1, sortScore: -1 });
companySchema.index({ status: 1, 'location.postal': 1 });

// Bayesian prior: assume a middling reputation until enough reviews accumulate.
const PRIOR_MEAN = 3.8;   // neutral-ish 5-point prior
const PRIOR_WEIGHT = 6;   // how many "virtual" reviews the prior is worth

/**
 * Recompute the blended scores from the per-source ratings.
 * aggregateScore = Σ(avg_i · count_i) / Σ(count_i)  across present sources.
 * rankScore      = (PRIOR_MEAN·PRIOR_WEIGHT + Σ(avg_i·count_i)) / (PRIOR_WEIGHT + Σ(count_i))
 */
companySchema.methods.recomputeScores = function () {
  const sources = [this.ratings.clockwork, this.ratings.google, this.ratings.yelp];
  let weighted = 0, total = 0;
  for (const s of sources) {
    if (s && s.count > 0) { weighted += s.avg * s.count; total += s.count; }
  }
  this.aggregateCount = total;
  this.aggregateScore = total > 0 ? +(weighted / total).toFixed(3) : 0;
  this.rankScore = +(((PRIOR_MEAN * PRIOR_WEIGHT) + weighted) / (PRIOR_WEIGHT + total)).toFixed(4);
  // Sort key = honest review score + adoption/verification boosts (NOT mixed into
  // the displayed rating). Blueprint-using, partnered, and verified companies rank up.
  const boost = (this.featured ? 1.0 : 0)
    + (this.partner ? 0.5 : 0)
    + (this.usesBlueprint ? 0.4 : 0)
    + (this.legal && this.legal.verified ? 0.3 : 0);
  this.sortScore = +(this.rankScore + boost).toFixed(4);
  return this;
};

companySchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Company', companySchema);
