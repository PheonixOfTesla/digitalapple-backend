const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Review = require('../models/Review');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { upload, cloudinary } = require('../config/cloudinary');

const router = express.Router();

// ALL routes require admin role - SERVER-SIDE ENFORCEMENT
router.use(verifyToken);
router.use(requireAdmin);

// ==================== USERS ====================

// List all users
router.get('/users', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  try {
    const [users, total] = await Promise.all([
      User.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-passwordHash -passwordResetToken -pendingEmailToken')
        .lean(),
      User.countDocuments()
    ]);

    const formattedUsers = users.map(user => ({
      id: user._id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      profilePhoto: user.profilePhoto,
      marketingOptIn: user.marketingOptIn,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt
    }));

    res.json({
      success: true,
      users: formattedUsers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Admin list users error:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Get single user
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-passwordHash -passwordResetToken -pendingEmailToken')
      .lean();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        profilePhoto: user.profilePhoto,
        marketingOptIn: user.marketingOptIn,
        emailVerified: user.emailVerified,
        pendingEmail: user.pendingEmail,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    });

  } catch (error) {
    console.error('Admin get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Get users with marketing opt-in
router.get('/marketing-list', async (req, res) => {
  try {
    const users = await User.find({ marketingOptIn: true })
      .select('email firstName lastName createdAt')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: users.length,
      users: users.map(u => ({
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        subscribedAt: u.createdAt
      }))
    });

  } catch (error) {
    console.error('Admin marketing list error:', error);
    res.status(500).json({ error: 'Failed to get marketing list' });
  }
});

// ==================== PRODUCTS ====================

// Create product
router.post('/products', async (req, res) => {
  const { name, tagline, description, image, status, link, order } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Product name required' });
  }

  try {
    const product = new Product({
      name: name.trim(),
      tagline: tagline?.trim(),
      description: description?.trim(),
      image,
      status: ['live', 'soon', '2027'].includes(status) ? status : 'soon',
      link: link?.trim(),
      order: order || 0
    });

    await product.save();

    console.log(`Product created: ${product.name}`);

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
        order: product.order,
        createdAt: product.createdAt
      }
    });

  } catch (error) {
    console.error('Admin create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Update product
router.put('/products/:id', async (req, res) => {
  const { name, tagline, description, image, status, link, order } = req.body;

  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    if (name !== undefined) product.name = name.trim();
    if (tagline !== undefined) product.tagline = tagline?.trim();
    if (description !== undefined) product.description = description?.trim();
    if (image !== undefined) product.image = image;
    if (status !== undefined && ['live', 'soon', '2027'].includes(status)) {
      product.status = status;
    }
    if (link !== undefined) product.link = link?.trim();
    if (order !== undefined) product.order = order;

    await product.save();

    console.log(`Product updated: ${product.name}`);

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
        order: product.order,
        updatedAt: product.updatedAt
      }
    });

  } catch (error) {
    console.error('Admin update product error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product
router.delete('/products/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Delete associated reviews
    await Review.deleteMany({ productId: product._id });

    await product.deleteOne();

    console.log(`Product deleted: ${req.params.id}`);

    res.json({ success: true });

  } catch (error) {
    console.error('Admin delete product error:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ==================== REVIEWS MODERATION ====================

// List all reviews (including hidden)
router.get('/reviews', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const showHidden = req.query.hidden === 'true';

  try {
    const query = showHidden ? {} : { hidden: { $ne: true } };

    const [reviews, total] = await Promise.all([
      Review.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('authorId', 'email firstName lastName')
        .populate('productId', 'name')
        .lean(),
      Review.countDocuments(query)
    ]);

    const formattedReviews = reviews.map(review => ({
      id: review._id,
      rating: review.rating,
      body: review.body,
      author: review.authorId ? {
        id: review.authorId._id,
        email: review.authorId.email,
        name: `${review.authorId.firstName || ''} ${review.authorId.lastName || ''}`.trim()
      } : null,
      product: review.productId ? {
        id: review.productId._id,
        name: review.productId.name
      } : null,
      hidden: review.hidden,
      hiddenReason: review.hiddenReason,
      createdAt: review.createdAt
    }));

    res.json({
      success: true,
      reviews: formattedReviews,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Admin list reviews error:', error);
    res.status(500).json({ error: 'Failed to list reviews' });
  }
});

// Hide/unhide review (moderate)
router.put('/reviews/:id/moderate', async (req, res) => {
  const { hidden, reason } = req.body;

  try {
    const review = await Review.findById(req.params.id);

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    review.hidden = hidden === true;
    review.hiddenReason = hidden ? reason : undefined;
    review.hiddenBy = hidden ? req.userId : undefined;

    await review.save();

    console.log(`Review ${hidden ? 'hidden' : 'unhidden'}: ${review._id}`);

    res.json({
      success: true,
      review: {
        id: review._id,
        hidden: review.hidden,
        hiddenReason: review.hiddenReason
      }
    });

  } catch (error) {
    console.error('Admin moderate review error:', error);
    res.status(500).json({ error: 'Failed to moderate review' });
  }
});

// Delete review (permanent)
router.delete('/reviews/:id', async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    await review.deleteOne();

    console.log(`Review deleted by admin: ${req.params.id}`);

    res.json({ success: true });

  } catch (error) {
    console.error('Admin delete review error:', error);
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// ==================== STATS ====================

router.get('/stats', async (req, res) => {
  try {
    const [userCount, productCount, reviewCount, marketingCount] = await Promise.all([
      User.countDocuments(),
      Product.countDocuments(),
      Review.countDocuments(),
      User.countDocuments({ marketingOptIn: true })
    ]);

    res.json({
      success: true,
      stats: {
        users: userCount,
        products: productCount,
        reviews: reviewCount,
        marketingSubscribers: marketingCount
      }
    });

  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

module.exports = router;
