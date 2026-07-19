/**
 * ApplicationController - Product directory applications
 *
 * Users submit applications (requires auth)
 * Users view their own applications
 */

const express = require('express');
const Application = require('../models/Application');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(verifyToken);

// Submit a new application
router.post('/', async (req, res) => {
  const {
    productName,
    url,
    company,
    role,
    useCase,
    deployment,
    pricing,
    modelUnderneath,
    description,
    dataPolicy,
    whyBelongs,
    accuracyConfirmed
  } = req.body;

  // Validation
  const errors = [];
  if (!productName?.trim()) errors.push('Product name is required');
  if (!url?.trim()) errors.push('URL is required');
  if (!company?.trim()) errors.push('Company is required');
  if (!role?.trim()) errors.push('Your role is required');
  if (!useCase?.trim()) errors.push('Use case is required');
  if (!deployment) errors.push('Deployment type is required');
  if (!pricing) errors.push('Pricing model is required');
  if (!description?.trim()) errors.push('Description is required');
  if (!dataPolicy?.trim()) errors.push('Data policy is required');
  if (!whyBelongs?.trim()) errors.push('Reason for inclusion is required');
  if (!accuracyConfirmed) errors.push('You must confirm the accuracy of information');

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  try {
    const application = new Application({
      productName: productName.trim(),
      url: url.trim(),
      company: company.trim(),
      role: role.trim(),
      useCase: useCase.trim(),
      deployment,
      pricing,
      modelUnderneath: modelUnderneath?.trim(),
      description: description.trim(),
      dataPolicy: dataPolicy.trim(),
      whyBelongs: whyBelongs.trim(),
      accuracyConfirmed: true,
      userId: req.userId,
      status: 'pending'
    });

    await application.save();

    console.log(`Application submitted: ${productName} by user ${req.userId}`);

    res.json({
      success: true,
      application: {
        id: application._id,
        productName: application.productName,
        company: application.company,
        status: application.status,
        createdAt: application.createdAt
      }
    });

  } catch (error) {
    console.error('Submit application error:', error);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// Get user's own applications
router.get('/mine', async (req, res) => {
  try {
    const applications = await Application.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      applications: applications.map(app => ({
        id: app._id,
        productName: app.productName,
        company: app.company,
        url: app.url,
        status: app.status,
        rejectionReason: app.rejectionReason,
        reviewedAt: app.reviewedAt,
        createdAt: app.createdAt
      }))
    });

  } catch (error) {
    console.error('Get my applications error:', error);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// Get single application (only own)
router.get('/:id', async (req, res) => {
  try {
    const application = await Application.findOne({
      _id: req.params.id,
      userId: req.userId
    }).lean();

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json({
      success: true,
      application: {
        id: application._id,
        productName: application.productName,
        url: application.url,
        company: application.company,
        role: application.role,
        useCase: application.useCase,
        deployment: application.deployment,
        pricing: application.pricing,
        modelUnderneath: application.modelUnderneath,
        description: application.description,
        dataPolicy: application.dataPolicy,
        whyBelongs: application.whyBelongs,
        status: application.status,
        rejectionReason: application.rejectionReason,
        reviewedAt: application.reviewedAt,
        createdAt: application.createdAt
      }
    });

  } catch (error) {
    console.error('Get application error:', error);
    res.status(500).json({ error: 'Failed to fetch application' });
  }
});

module.exports = router;
