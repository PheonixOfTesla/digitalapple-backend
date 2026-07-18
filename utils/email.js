const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendEmail({ to, subject, html }) {
  try {
    await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to,
      subject,
      html
    });
    return true;
  } catch (error) {
    console.error('Email send error:', error);
    return false;
  }
}

async function sendVerificationEmail(email, token) {
  const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;

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
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

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
  const verifyUrl = `${process.env.FRONTEND_URL}/verify-email-change?token=${token}`;

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
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendEmailChangeVerification
};
