const nodemailer = require('nodemailer');
const config = require('../config');

const getMaskedEmailConfig = () => ({
  host: config.smtp.host || null,
  port: config.smtp.port || null,
  secure: config.smtp.secure,
  user: config.smtp.user || null,
  from_email: config.smtp.fromEmail || null,
});

const validateEmailConfig = () => {
  const missing = [];

  if (!config.smtp.host) missing.push('SMTP_HOST');
  if (!config.smtp.port) missing.push('SMTP_PORT');
  if (!config.smtp.user) missing.push('SMTP_USER');
  if (!config.smtp.pass) missing.push('SMTP_PASS');
  if (!config.smtp.fromEmail) missing.push('SMTP_FROM_EMAIL or SMTP_USER');

  if (missing.length) {
    throw new Error(`Email config missing: ${missing.join(', ')}`);
  }
};

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass,
  },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 20000,
});

let transportVerified = false;

const ensureTransportReady = async () => {
  validateEmailConfig();

  if (transportVerified) return;

  try {
    await transporter.verify();
    transportVerified = true;
    if (config.verboseLogs) {
      console.info('[Email Service][SMTP Ready]', getMaskedEmailConfig());
    }
  } catch (error) {
    console.error('[Email Service][SMTP Verify Failed]', {
      config: getMaskedEmailConfig(),
      message: error.message,
      code: error.code || null,
      response: error.response || null,
    });
    throw error;
  }
};

const sendEmail = async ({ to, subject, html }) => {
  try {
    await ensureTransportReady();

    const info = await transporter.sendMail({
      from: `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
      to,
      subject,
      html,
    });

    if (config.verboseLogs) {
      console.info('[Email Service][Sent]', {
        to,
        subject,
        message_id: info.messageId,
        response: info.response || null,
      });
    }

    return info;
  } catch (error) {
    console.error('[Email Service][Send Failed]', {
      to,
      subject,
      config: getMaskedEmailConfig(),
      message: error.message,
      code: error.code || null,
      command: error.command || null,
      response: error.response || null,
    });
    throw error;
  }
};

const sendVerificationEmail = async (user, token) => {
  const verifyUrl = `${config.frontendUrl}/verify-email?token=${token}`;

  await sendEmail({
    to: user.email,
    subject: 'Verify your email - WBIZ.IN',
    html: `
      <div style="font-family: 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #075E54; font-size: 28px; margin: 0;">WBIZ.IN</h1>
        </div>
        <div style="background: #ffffff; border-radius: 12px; padding: 40px; border: 1px solid #e5e7eb;">
          <h2 style="color: #1a1a1a; font-size: 22px; margin: 0 0 16px;">Welcome, ${user.full_name}!</h2>
          <p style="color: #6b7280; font-size: 16px; line-height: 1.6; margin: 0 0 24px;">
            Thanks for signing up. Please verify your email address to get started with your WhatsApp Business platform.
          </p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${verifyUrl}" style="background: #075E54; color: #ffffff; padding: 14px 40px; border-radius: 8px; text-decoration: none; font-size: 16px; font-weight: 600; display: inline-block;">
              Verify Email Address
            </a>
          </div>
          <p style="color: #9ca3af; font-size: 13px; margin: 24px 0 0; text-align: center;">
            This link expires in 1 hour. If you didn't create an account, you can safely ignore this email.
          </p>
        </div>
      </div>
    `,
  });
};

const sendPasswordResetEmail = async (user, token) => {
  const resetUrl = `${config.frontendUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: user.email,
    subject: 'Reset your password - WBIZ.IN',
    html: `
      <div style="font-family: 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #075E54; font-size: 28px; margin: 0;">WBIZ.IN</h1>
        </div>
        <div style="background: #ffffff; border-radius: 12px; padding: 40px; border: 1px solid #e5e7eb;">
          <h2 style="color: #1a1a1a; font-size: 22px; margin: 0 0 16px;">Password Reset Request</h2>
          <p style="color: #6b7280; font-size: 16px; line-height: 1.6; margin: 0 0 24px;">
            We received a request to reset your password. Click the button below to choose a new password.
          </p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${resetUrl}" style="background: #075E54; color: #ffffff; padding: 14px 40px; border-radius: 8px; text-decoration: none; font-size: 16px; font-weight: 600; display: inline-block;">
              Reset Password
            </a>
          </div>
          <p style="color: #9ca3af; font-size: 13px; margin: 24px 0 0; text-align: center;">
            This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
          </p>
        </div>
      </div>
    `,
  });
};

module.exports = { sendEmail, sendVerificationEmail, sendPasswordResetEmail };
