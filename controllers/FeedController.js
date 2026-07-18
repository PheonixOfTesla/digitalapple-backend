const express = require('express');
const Product = require('../models/Product');
const Review = require('../models/Review');
const User = require('../models/User');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// Get feed (products with reviews, paginated)
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const skip = (page - 1) * limit;

  try {
    const [products, total] = await Promise.all([
      Product.find()
        .sort({ order: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments()
    ]);

    // Get reviews for these products (excluding hidden ones)
    const productIds = products.map(p => p._id);
    const reviews = await Review.find({
      productId: { $in: productIds },
      hidden: { $ne: true }
    })
      .sort({ createdAt: -1 })
      .populate('authorId', 'firstName lastName profilePhoto profilePhotoThumb')
      .lean();

    // Group reviews by product
    const reviewsByProduct = {};
    reviews.forEach(review => {
      const pid = review.productId.toString();
      if (!reviewsByProduct[pid]) {
        reviewsByProduct[pid] = [];
      }
      reviewsByProduct[pid].push({
        id: review._id,
        rating: review.rating,
        body: review.body,
        author: review.authorId ? {
          id: review.authorId._id,
          firstName: review.authorId.firstName,
          lastName: review.authorId.lastName,
          profilePhoto: review.authorId.profilePhoto,
          profilePhotoThumb: review.authorId.profilePhotoThumb
        } : null,
        createdAt: review.createdAt
      });
    });

    // Attach reviews to products
    const feedItems = products.map(product => ({
      id: product._id,
      name: product.name,
      tagline: product.tagline,
      description: product.description,
      image: product.image,
      status: product.status,
      link: product.link,
      reviews: reviewsByProduct[product._id.toString()] || [],
      createdAt: product.createdAt
    }));

    res.json({
      success: true,
      feed: feedItems,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// Get single product with reviews
router.get('/product/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const reviews = await Review.find({
      productId: product._id,
      hidden: { $ne: true }
    })
      .sort({ createdAt: -1 })
      .populate('authorId', 'firstName lastName profilePhoto profilePhotoThumb')
      .lean();

    const formattedReviews = reviews.map(review => ({
      id: review._id,
      rating: review.rating,
      body: review.body,
      author: review.authorId ? {
        id: review.authorId._id,
        firstName: review.authorId.firstName,
        lastName: review.authorId.lastName,
        profilePhoto: review.authorId.profilePhoto,
        profilePhotoThumb: review.authorId.profilePhotoThumb
      } : null,
      createdAt: review.createdAt
    }));

    res.json({
      success: true,
      product: {
        id: product._id,
        name: product.name,
        tagline: product.tagline,
        description: product.description,
        image: product.image,
        status: product.status,
        link: product.link,
        reviews: formattedReviews,
        createdAt: product.createdAt
      }
    });

  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Failed to get product' });
  }
});

// Post a review (one per user per product)
router.post('/product/:id/review', verifyToken, async (req, res) => {
  const { rating, body } = req.body;

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Check for existing review
    const existing = await Review.findOne({
      productId: product._id,
      authorId: req.userId
    });

    if (existing) {
      return res.status(400).json({ error: 'You have already reviewed this product' });
    }

    const review = new Review({
      productId: product._id,
      authorId: req.userId,
      rating: Math.round(rating),
      body: body?.trim()?.slice(0, 1000)
    });

    await review.save();

    // Get author info for response
    const user = await User.findById(req.userId);

    console.log(`Review posted: ${user.email} on ${product.name}`);

    res.json({
      success: true,
      review: {
        id: review._id,
        rating: review.rating,
        body: review.body,
        author: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          profilePhoto: user.profilePhoto,
          profilePhotoThumb: user.profilePhotoThumb
        },
        createdAt: review.createdAt
      }
    });

  } catch (error) {
    console.error('Post review error:', error);
    res.status(500).json({ error: 'Failed to post review' });
  }
});

// Edit own review
router.put('/review/:id', verifyToken, async (req, res) => {
  const { rating, body } = req.body;

  try {
    const review = await Review.findById(req.params.id);

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Server-enforced: can only edit own review
    if (review.authorId.toString() !== req.userId) {
      return res.status(403).json({ error: 'Cannot edit another user\'s review' });
    }

    if (rating !== undefined) {
      if (rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
      }
      review.rating = Math.round(rating);
    }

    if (body !== undefined) {
      review.body = body?.trim()?.slice(0, 1000);
    }

    await review.save();

    console.log(`Review edited: ${review._id}`);

    res.json({
      success: true,
      review: {
        id: review._id,
        rating: review.rating,
        body: review.body,
        updatedAt: review.updatedAt
      }
    });

  } catch (error) {
    console.error('Edit review error:', error);
    res.status(500).json({ error: 'Failed to edit review' });
  }
});

// Delete own review
router.delete('/review/:id', verifyToken, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Server-enforced: can only delete own review
    if (review.authorId.toString() !== req.userId) {
      return res.status(403).json({ error: 'Cannot delete another user\'s review' });
    }

    await review.deleteOne();

    console.log(`Review deleted: ${req.params.id}`);

    res.json({ success: true });

  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// Get user's own reviews
router.get('/my-reviews', verifyToken, async (req, res) => {
  try {
    const reviews = await Review.find({ authorId: req.userId })
      .sort({ createdAt: -1 })
      .populate('productId', 'name image')
      .lean();

    const formattedReviews = reviews.map(review => ({
      id: review._id,
      rating: review.rating,
      body: review.body,
      product: review.productId ? {
        id: review.productId._id,
        name: review.productId.name,
        image: review.productId.image
      } : null,
      hidden: review.hidden,
      createdAt: review.createdAt
    }));

    res.json({
      success: true,
      reviews: formattedReviews
    });

  } catch (error) {
    console.error('Get my reviews error:', error);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

module.exports = router;
