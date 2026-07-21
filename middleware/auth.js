const jwt = require('jsonwebtoken');

// Verify JWT token middleware
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(403).json({ error: 'No token provided' });
  }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    req.userEmail = decoded.email;
    req.userRole = decoded.role;
    next();
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth - extracts user if token present, continues if not
// Also extracts X-Session-Id for anonymous session tracking
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (authHeader) {
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.userId = decoded.id;
      req.userEmail = decoded.email;
      req.userRole = decoded.role;
    } catch (error) {
      // Invalid token, continue as anonymous
    }
  }

  // Extract anonymous session ID from header (for token purchases without auth)
  if (!req.userId) {
    req.anonymousSessionId = req.headers['x-session-id'] || req.query.sessionId;
  }

  next();
}

// Require specific role(s) middleware - SERVER-SIDE ENFORCEMENT
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.userRole) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!allowedRoles.includes(req.userRole)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        message: 'You do not have access to this resource'
      });
    }

    next();
  };
}

// Require admin role - explicit admin-only check
function requireAdmin(req, res, next) {
  if (!req.userRole || req.userRole !== 'admin') {
    return res.status(403).json({
      error: 'Admin access required',
      message: 'This endpoint is restricted to administrators'
    });
  }
  next();
}

// Generate JWT token
function generateToken(user) {
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      role: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Generate short-lived token for email verification/password reset
function generateVerificationToken(payload) {
  return jwt.sign(
    payload,
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function generatePasswordResetToken(payload) {
  return jwt.sign(
    payload,
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function verifyEmailToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return null;
  }
}

module.exports = {
  verifyToken,
  optionalAuth,
  requireRole,
  requireAdmin,
  generateToken,
  generateVerificationToken,
  generatePasswordResetToken,
  verifyEmailToken
};
