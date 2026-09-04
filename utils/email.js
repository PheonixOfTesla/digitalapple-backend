const nodemailer = require('nodemailer');
const { siteUrl } = require('../services/siteUrl');

/**
 * Two ways out, in order of preference.
 *
 * Resend (RESEND_API_KEY) is what the other services on this account already
 * send through, so a deploy that has that key can send mail here with nothing
 * new to provision. SMTP is the fallback for anywhere that has a mailbox
 * instead. With neither, mail is logged and everything else still works — a
 * booking is never lost because a mail server is missing.
 *
 * Resend is called over plain HTTPS rather than through its SDK: one POST, no
 * dependency, and nothing to keep in step at install time.
 */
const RESEND_KEY = String(process.env.RESEND_API_KEY || '').trim();
const isSmtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter = null;

if (isSmtpConfigured) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

if (RESEND_KEY) console.log('Email: Resend configured' + (isSmtpConfigured ? ' (SMTP available as fallback)' : ''));
else if (isSmtpConfigured) console.log('Email transporter configured');
else console.log('Email not configured - emails will be logged only');

/** Which way mail is going out, for /health to report without leaking a key. */
function emailProvider() {
  if (RESEND_KEY) return 'resend';
  if (isSmtpConfigured) return 'smtp';
  return 'none';
}

/**
 * The From address. Resend refuses any domain the account has not verified, so
 * the Resend-specific variable wins where it is set — using a Gmail address
 * there produces a 403 and no email, with nothing in the UI to explain it.
 */
function fromAddress() {
  return process.env.RESEND_FROM_EMAIL
    || process.env.FROM_EMAIL
    || 'noreply@digitalapple.co';
}

async function sendViaResend({ to, subject, html, replyTo }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign(
      { from: fromAddress(), to: [to], subject, html },
      replyTo ? { reply_to: replyTo } : {}
    ))
  });
  if (!r.ok) {
    // The body names the cause — an unverified domain, a bad key — and it is
    // the only place that says so. Worth the log line.
    const body = await r.text().catch(() => '');
    throw new Error(`resend ${r.status}: ${body.slice(0, 300)}`);
  }
  return true;
}

async function sendEmail({ to, subject, html, replyTo }) {
  if (!to) return false;

  if (RESEND_KEY) {
    try {
      return await sendViaResend({ to, subject, html, replyTo });
    } catch (error) {
      console.error('Email send error (resend):', error.message);
      // Fall through to SMTP where there is one; otherwise report the failure.
      if (!transporter) return false;
    }
  }

  if (!transporter) {
    console.log(`[Email Mock] To: ${to}, Subject: ${subject}`);
    return true; // Simulate success for testing
  }

  try {
    await transporter.sendMail(Object.assign(
      { from: fromAddress(), to, subject, html },
      replyTo ? { replyTo } : {}
    ));
    return true;
  } catch (error) {
    console.error('Email send error:', error);
    return false;
  }
}

async function sendVerificationEmail(email, token) {
  const verifyUrl = `${siteUrl()}/verify-email?token=${token}`;

  return sendEmail({
    to: email,
    subject: 'Verify your email - DigitalApple',
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 500px; margin: 0 auto; padding: 40px; background: #0A0A0F; color: #F0F4F8;">
        <h1 style="color: #00E5FF; font-size: 24px; margin-bottom: 24px;">Verify Your Email</h1>
        <p style="color: #8A9BAE; margin-bottom: 24px;">Click the button below to verify your email address:</p>
        <a href="${verifyUrl}" style="display: inline-block; background: #00E5FF; color: #0A0A0F; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: 600;">Verify Email</a>
        <p style="color: #505868; margin-top: 24px; font-size: 12px;">This link expires in 24 hours.</p>
      </div>
    `
  });
}

async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${siteUrl()}/reset-password?token=${token}`;

  return sendEmail({
    to: email,
    subject: 'Reset your password - DigitalApple',
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 500px; margin: 0 auto; padding: 40px; background: #0A0A0F; color: #F0F4F8;">
        <h1 style="color: #00E5FF; font-size: 24px; margin-bottom: 24px;">Reset Your Password</h1>
        <p style="color: #8A9BAE; margin-bottom: 24px;">Click the button below to reset your password:</p>
        <a href="${resetUrl}" style="display: inline-block; background: #00E5FF; color: #0A0A0F; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: 600;">Reset Password</a>
        <p style="color: #505868; margin-top: 24px; font-size: 12px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
      </div>
    `
  });
}

async function sendEmailChangeVerification(newEmail, token) {
  const verifyUrl = `${siteUrl()}/verify-email-change?token=${token}`;

  return sendEmail({
    to: newEmail,
    subject: 'Confirm your new email - DigitalApple',
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 500px; margin: 0 auto; padding: 40px; background: #0A0A0F; color: #F0F4F8;">
        <h1 style="color: #00E5FF; font-size: 24px; margin-bottom: 24px;">Confirm Email Change</h1>
        <p style="color: #8A9BAE; margin-bottom: 24px;">Click the button below to confirm this as your new email address:</p>
        <a href="${verifyUrl}" style="display: inline-block; background: #00E5FF; color: #0A0A0F; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: 600;">Confirm New Email</a>
        <p style="color: #505868; margin-top: 24px; font-size: 12px;">This link expires in 24 hours.</p>
      </div>
    `
  });
}

module.exports = {
  sendEmail,
  emailProvider,
  fromAddress,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendEmailChangeVerification
};
