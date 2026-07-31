const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { verifyToken, generateToken, generateVerificationToken, generatePasswordResetToken, verifyEmailToken } = require('../middleware/auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/email');
const { resolveReferrer, publicReferrer } = require('../services/referrals');

const router = express.Router();

/**
 * Who's behind an invite link — public, unauthenticated, used by the landing
 * page to say "X invited you" before anyone has an account.
 *
 * Returns 200 with referrer:null for an unknown token rather than 404: a dead
 * invite link should quietly become a normal signup page, not an error screen.
 */
router.get('/invite/:ref', async (req, res) => {
  try {
    const u = await resolveReferrer(req.params.ref);
    res.json({ success: true, referrer: publicReferrer(u) });
  } catch (e) {
    console.error('Invite lookup error:', e.message);
    res.json({ success: true, referrer: null });
  }
});

// Register
router.post('/register', async (req, res) => {
  const { email, password, firstName, lastName, marketingOptIn, ref } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Attribution: resolve the referral token the signup arrived with. Resolved
    // SERVER-SIDE from a handle or id — the client sends the token it saw in the
    // URL, never a user id it picked. A token that doesn't resolve is simply
    // ignored: a stale or mistyped link should still let someone sign up.
    let invitedBy = null;
    if (ref) {
      const referrer = await resolveReferrer(ref);
      if (referrer) invitedBy = referrer._id;
    }

    // Role is always 'user' - never accept from client
    const user = new User({
      email: email.toLowerCase(),
      passwordHash,
      role: 'user',
      firstName: firstName?.trim(),
      lastName: lastName?.trim(),
      marketingOptIn: marketingOptIn === true,
      invitedBy
    });

    await user.save();

    // Send verification email
    const verifyToken = generateVerificationToken({ userId: user._id, email: user.email, type: 'verify' });
    await sendVerificationEmail(user.email, verifyToken);

    const token = generateToken(user);

    require('../models/Notification').pushAdmins({
      type: 'admin_signup', text: `New Hub created: ${[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}`, link: 'admin.html#users'
    });

    console.log(`User registered: ${user.email}`);

    res.json({
      success: true,
      token,
      user: user.toPrivateProfile(),
      message: 'Please check your email to verify your account'
    });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);

    console.log(`User logged in: ${user.email} (${user.role})`);

    res.json({
      success: true,
      token,
      user: user.toPrivateProfile()
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout (client-side token removal, but endpoint for consistency)
router.post('/logout', verifyToken, (req, res) => {
  res.json({ success: true, message: 'Logged out' });
});

// Get current user
router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      user: user.toPrivateProfile()
    });

  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Verify email
router.post('/verify-email', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }

  try {
    const decoded = verifyEmailToken(token);

    if (!decoded || decoded.type !== 'verify') {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.emailVerified) {
      return res.json({ success: true, message: 'Email already verified' });
    }

    user.emailVerified = true;
    await user.save();

    console.log(`Email verified: ${user.email}`);

    res.json({ success: true, message: 'Email verified successfully' });

  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Request password reset
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase() });

    // Don't reveal if user exists
    if (!user) {
      return res.json({ success: true, message: 'If an account exists, a reset link has been sent' });
    }

    const resetToken = generatePasswordResetToken({ userId: user._id, type: 'reset' });

    user.passwordResetToken = resetToken;
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    await sendPasswordResetEmail(user.email, resetToken);

    console.log(`Password reset requested: ${user.email}`);

    res.json({ success: true, message: 'If an account exists, a reset link has been sent' });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// Reset password
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password required' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const decoded = verifyEmailToken(token);

    if (!decoded || decoded.type !== 'reset') {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.passwordResetToken !== token) {
      return res.status(400).json({ error: 'Invalid token' });
    }

    if (user.passwordResetExpires < new Date()) {
      return res.status(400).json({ error: 'Token expired' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    console.log(`Password reset: ${user.email}`);

    res.json({ success: true, message: 'Password reset successfully' });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ==================== GOOGLE SIGN-IN (server-side OAuth) ====================
const jwt = require('jsonwebtoken');

const GOOGLE = {
  clientId: () => process.env.GOOGLE_CLIENT_ID,
  clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: () => process.env.GOOGLE_REDIRECT_URI ||
    'https://digitalapple-backend-production.up.railway.app/api/v1/auth/google/callback',
  frontend: () => process.env.FRONTEND_URL || 'https://theclockworkhub.com',
  configured: () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
};

// Lets the frontend decide whether to show the "Continue with Google" button.
router.get('/google/status', (req, res) => res.json({ configured: GOOGLE.configured() }));

// Step 1 — bounce the user to Google's consent screen.
router.get('/google', (req, res) => {
  if (!GOOGLE.configured()) return res.status(503).json({ error: 'Google sign-in not configured' });
  // Optional return path: land the user back where they started (a Studio
  // link, a lobby) instead of the generic Hub. Same-site paths only.
  let ret = String(req.query.return || '');
  if (!/^\/[^/\\]/.test(ret) || ret.length > 300) ret = '';
  // Signed, short-lived state guards against CSRF on the callback.
  const state = jwt.sign({ t: 'goauth', r: ret || undefined }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: GOOGLE.clientId(),
    redirect_uri: GOOGLE.redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    state
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

// Step 2 — Google redirects back with a code; exchange it, sign the user in.
router.get('/google/callback', async (req, res) => {
  const fail = (msg) => res.redirect(GOOGLE.frontend() + '/host-portal.html#gerror=' + encodeURIComponent(msg));
  try {
    if (!GOOGLE.configured()) return fail('not_configured');
    const { code, state } = req.query;
    if (!code) return fail('no_code');
    let ret = '';
    try {
      const st = jwt.verify(state, process.env.JWT_SECRET);
      if (st && typeof st.r === 'string' && /^\/[^/\\]/.test(st.r) && st.r.length <= 300) ret = st.r;
    } catch (e) { return fail('bad_state'); }

    // Exchange the authorization code for tokens.
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE.clientId(), client_secret: GOOGLE.clientSecret(),
        redirect_uri: GOOGLE.redirectUri(), grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return fail('token_exchange');

    // Fetch the verified profile.
    const uiRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + tokens.access_token }
    });
    const p = await uiRes.json();
    if (!p || !p.sub || !p.email) return fail('no_profile');
    const email = String(p.email).toLowerCase();

    // Find by googleId, then link by email, else create a fresh Hub.
    let user = await User.findOne({ googleId: p.sub });
    if (!user) user = await User.findOne({ email });
    if (!user) {
      const randomHash = await bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), 10);
      user = new User({
        email, passwordHash: randomHash, role: 'user',
        firstName: p.given_name || '', lastName: p.family_name || '',
        googleId: p.sub, profilePhoto: p.picture || undefined,
        emailVerified: !!p.email_verified
      });
      await user.save();
      require('../models/Notification').pushAdmins({
        type: 'admin_signup', text: `New Hub via Google: ${p.name || email}`, link: 'admin.html#users'
      });
    } else if (!user.googleId) {
      user.googleId = p.sub;
      if (!user.profilePhoto && p.picture) user.profilePhoto = p.picture;
      await user.save();
    }

    const token = generateToken(user);
    // Hand the JWT to the frontend via the URL fragment (never logged by
    // servers). Land back where they started — a Studio link stays a Studio.
    res.redirect(GOOGLE.frontend() + (ret || '/host-portal.html') + '#gtoken=' + token);
  } catch (e) {
    console.error('[google callback]', e.message);
    fail('server_error');
  }
});

module.exports = router;
