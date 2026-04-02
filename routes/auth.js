const express = require('express');
const jwt = require('jsonwebtoken');
const validator = require('validator');
const config = require('../config');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const RefreshToken = require('../models/RefreshToken');
const EmailVerification = require('../models/EmailVerification');
const { authenticate } = require('../middleware/auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/emailService');
const { generateToken, hashToken, createSlug, apiResponse } = require('../utils/helpers');
const { parsePhoneInput } = require('../utils/phone');

const router = express.Router();
const localhostPattern = /(^|:\/\/)(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i;
const shouldExposeForgotPasswordDebug = (req) => {
  if (config.nodeEnv !== 'production') return true;

  const requestParts = [
    req.get('origin'),
    req.get('referer'),
    req.get('host'),
    req.get('x-forwarded-host'),
    req.hostname,
  ].filter(Boolean);

  return requestParts.some((value) => localhostPattern.test(String(value)));
};

// ─── REGISTER ──────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const {
      full_name, email, password, confirm_password,
      phone, company_name, country, industry, whatsapp_number
    } = req.body;
    const parsedPhone = parsePhoneInput({ phone });
    const parsedWhatsAppNumber = whatsapp_number ? parsePhoneInput({ phone: whatsapp_number }) : { ok: true, phone: null };

    // Validation
    const errors = [];
    if (!full_name || full_name.trim().length < 2) errors.push('Full name must be at least 2 characters');
    if (!email || !validator.isEmail(email)) errors.push('Valid email is required');
    if (!password || password.length < 8) errors.push('Password must be at least 8 characters');
    if (!/[A-Z]/.test(password)) errors.push('Password must contain at least 1 uppercase letter');
    if (!/[0-9]/.test(password)) errors.push('Password must contain at least 1 number');
    if (password !== confirm_password) errors.push('Passwords do not match');
    if (!phone) errors.push('Phone number is required');
    if (phone && !parsedPhone.ok) errors.push(parsedPhone.error);
    if (whatsapp_number && !parsedWhatsAppNumber.ok) errors.push(`WhatsApp number: ${parsedWhatsAppNumber.error}`);
    if (!company_name) errors.push('Company name is required');
    if (!country) errors.push('Country is required');

    if (errors.length > 0) {
      return apiResponse(res, { status: 400, success: false, error: errors.join(', ') });
    }

    // Check if email already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return apiResponse(res, { status: 409, success: false, error: 'An account with this email already exists' });
    }

    // Create user first (without tenant_id)
    const user = await User.create({
      email: email.toLowerCase(),
      password_hash: password, // Pre-save hook handles hashing
      full_name: full_name.trim(),
      phone: parsedPhone.phone,
      company_name,
      country,
      industry: industry || null,
      whatsapp_number: parsedWhatsAppNumber.phone || null,
      status: 'pending_verification',
      role: 'owner',
      tenant_id: null,
    });

    // Create tenant with owner
    const tenant = await Tenant.create({
      owner_user_id: user._id,
      name: company_name,
      slug: createSlug(company_name),
    });

    // Link tenant to user
    user.tenant_id = tenant._id;
    await user.save();

    // Generate verification token
    const rawToken = generateToken();
    await EmailVerification.create({
      user_id: user._id,
      token_hash: hashToken(rawToken),
      type: 'register',
      expires_at: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    });

    // Send verification email
    try {
      await sendVerificationEmail(user, rawToken);
    } catch (emailErr) {
      console.error('Failed to send verification email:', emailErr.message);
      // Don't fail the registration if email fails
    }

    return apiResponse(res, {
      status: 201,
      data: {
        user_id: user._id,
        email: user.email,
        message: 'Registration successful. Please check your email to verify your account.',
      },
    });
  } catch (error) {
    console.error('Register error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Registration failed. Please try again.' });
  }
});

// ─── VERIFY EMAIL ──────────────────────────────────────────
router.post('/verify-email', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return apiResponse(res, { status: 400, success: false, error: 'Verification token is required' });
    }

    const tokenDoc = await EmailVerification.findOne({
      token_hash: hashToken(token),
      type: 'register',
      used_at: null,
    });

    if (!tokenDoc) {
      return apiResponse(res, { status: 400, success: false, error: 'Invalid or expired verification token' });
    }

    if (tokenDoc.expires_at < new Date()) {
      return apiResponse(res, { status: 400, success: false, error: 'Verification token has expired. Please request a new one.' });
    }

    // Mark token as used
    tokenDoc.used_at = new Date();
    await tokenDoc.save();

    // Update user status
    const user = await User.findById(tokenDoc.user_id);
    user.status = 'pending_setup';
    user.email_verified_at = new Date();
    await user.save();

    // Generate tokens and auto-login
    const accessToken = jwt.sign(
      { userId: user._id, tenantId: user.tenant_id },
      config.jwt.secret,
      { expiresIn: config.jwt.accessExpiry }
    );

    const refreshRaw = generateToken();
    await RefreshToken.create({
      user_id: user._id,
      token_hash: hashToken(refreshRaw),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
    });

    res.cookie('refresh_token', refreshRaw, {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return apiResponse(res, {
      data: {
        access_token: accessToken,
        user: user.toSafeJSON(),
        redirect_to: '/portal/setup',
      },
    });
  } catch (error) {
    console.error('Verify email error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Verification failed' });
  }
});

// ─── RESEND VERIFICATION ───────────────────────────────────
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase(), status: 'pending_verification' });

    if (user) {
      const rawToken = generateToken();
      await EmailVerification.create({
        user_id: user._id,
        token_hash: hashToken(rawToken),
        type: 'register',
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
      });
      try {
        await sendVerificationEmail(user, rawToken);
      } catch (e) {
        console.error('Resend email failed:', e.message);
      }
    }

    // Always return success to prevent email enumeration
    return apiResponse(res, { data: { message: 'If the email exists, a verification link has been sent.' } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to resend verification' });
  }
});

// ─── LOGIN ─────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password, remember_me } = req.body;

    if (!email || !password) {
      return apiResponse(res, { status: 400, success: false, error: 'Email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    // Check lockout
    if (user?.locked_until && user.locked_until > new Date()) {
      const remaining = Math.ceil((user.locked_until - Date.now()) / 60000);
      return apiResponse(res, {
        status: 429,
        success: false,
        error: `Account locked. Try again in ${remaining} minute(s).`,
        data: { locked_until: user.locked_until },
      });
    }

    if (!user || !(await user.comparePassword(password))) {
      // Increment failed attempts
      if (user) {
        user.login_attempts += 1;
        if (user.login_attempts >= 5) {
          user.locked_until = new Date(Date.now() + 15 * 60 * 1000); // 15 min
          user.login_attempts = 0;
        }
        await user.save();
      }
      return apiResponse(res, { status: 401, success: false, error: 'Invalid email or password' });
    }

    if (user.status === 'pending_verification') {
      return apiResponse(res, {
        status: 403,
        success: false,
        error: 'Please verify your email first',
        data: { code: 'EMAIL_NOT_VERIFIED', email: user.email },
      });
    }

    if (user.status === 'suspended') {
      return apiResponse(res, { status: 403, success: false, error: 'Account suspended. Please contact support.' });
    }

    // Reset login attempts
    user.login_attempts = 0;
    user.locked_until = null;
    user.last_login_at = new Date();
    await user.save();

    // Generate access token
    const accessToken = jwt.sign(
      { userId: user._id, tenantId: user.tenant_id },
      config.jwt.secret,
      { expiresIn: config.jwt.accessExpiry }
    );

    // Generate refresh token
    const refreshRaw = generateToken();
    const refreshExpiry = remember_me ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    await RefreshToken.create({
      user_id: user._id,
      token_hash: hashToken(refreshRaw),
      expires_at: new Date(Date.now() + refreshExpiry),
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
    });

    res.cookie('refresh_token', refreshRaw, {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: refreshExpiry,
    });

    // Determine redirect
    let redirect_to = '/portal/dashboard';
    if (user.status === 'pending_setup') redirect_to = '/portal/setup';

    return apiResponse(res, {
      data: {
        access_token: accessToken,
        user: user.toSafeJSON(),
        redirect_to,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Login failed' });
  }
});

// ─── REFRESH TOKEN ─────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const rawToken = req.cookies?.refresh_token;
    if (!rawToken) {
      return apiResponse(res, { status: 401, success: false, error: 'Refresh token required' });
    }

    const tokenDoc = await RefreshToken.findOne({
      token_hash: hashToken(rawToken),
      revoked_at: null,
    });

    if (!tokenDoc || tokenDoc.expires_at < new Date()) {
      return apiResponse(res, { status: 401, success: false, error: 'Invalid or expired refresh token' });
    }

    const user = await User.findById(tokenDoc.user_id);
    if (!user || user.status === 'suspended') {
      return apiResponse(res, { status: 401, success: false, error: 'User not found or suspended' });
    }

    // Rotate refresh token
    tokenDoc.revoked_at = new Date();
    await tokenDoc.save();

    const newRefreshRaw = generateToken();
    await RefreshToken.create({
      user_id: user._id,
      token_hash: hashToken(newRefreshRaw),
      expires_at: tokenDoc.expires_at,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
    });

    res.cookie('refresh_token', newRefreshRaw, {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: tokenDoc.expires_at - Date.now(),
    });

    const accessToken = jwt.sign(
      { userId: user._id, tenantId: user.tenant_id },
      config.jwt.secret,
      { expiresIn: config.jwt.accessExpiry }
    );

    return apiResponse(res, { data: { access_token: accessToken } });
  } catch (error) {
    console.error('Refresh error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Token refresh failed' });
  }
});

// ─── LOGOUT ────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const rawToken = req.cookies?.refresh_token;
    if (rawToken) {
      await RefreshToken.updateOne(
        { token_hash: hashToken(rawToken) },
        { revoked_at: new Date() }
      );
      res.clearCookie('refresh_token');
    }
    return apiResponse(res, { data: { message: 'Logged out successfully' } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Logout failed' });
  }
});

// ─── FORGOT PASSWORD ───────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const debugEnabled = shouldExposeForgotPasswordDebug(req);
    const debugState = {
      requested_email: email?.toLowerCase() || null,
      debug_exposed: debugEnabled,
      debug_reason: config.nodeEnv !== 'production' ? 'non_production_env' : 'localhost_request',
      user_found: false,
      skipped_reason: null,
      token_created: false,
      email_attempted: false,
      email_sent: false,
      email_error: null,
    };

    res.set('X-Forgot-Password-Debug', debugEnabled ? 'enabled' : 'disabled');
    if (config.verboseLogs) {
      console.info('[Auth][Forgot Password][Received]', {
        email: email?.toLowerCase() || null,
        debug_enabled: debugEnabled,
      });
    }
    const user = await User.findOne({ email: email?.toLowerCase() });

    if (user && user.status !== 'pending_verification') {
      debugState.user_found = true;
      if (config.verboseLogs) {
        console.info('[Auth][Forgot Password][Requested]', {
          email: user.email,
          user_id: String(user._id),
        });
      }
      const rawToken = generateToken();
      await EmailVerification.create({
        user_id: user._id,
        token_hash: hashToken(rawToken),
        type: 'password_reset',
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
      });
      debugState.token_created = true;
      try {
        debugState.email_attempted = true;
        await sendPasswordResetEmail(user, rawToken);
        debugState.email_sent = true;
        if (config.verboseLogs) {
          console.info('[Auth][Forgot Password][Email Sent]', {
            email: user.email,
            user_id: String(user._id),
          });
        }
      } catch (e) {
        debugState.email_error = e.message;
        console.error('[Auth][Forgot Password][Email Failed]', {
          email: user.email,
          user_id: String(user._id),
          message: e.message,
        });
      }
    } else {
      debugState.skipped_reason = user ? 'pending_verification' : 'user_not_found';
      if (config.verboseLogs) {
        console.info('[Auth][Forgot Password][Skipped]', {
          email: email?.toLowerCase() || null,
          reason: user ? 'pending_verification' : 'user_not_found',
        });
      }
    }

    // Always return success - no email enumeration
    return apiResponse(res, {
      data: {
        message: 'If that email exists, a password reset link has been sent.',
        ...(debugEnabled ? { debug: debugState } : {}),
      },
    });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Request failed' });
  }
});

// ─── RESET PASSWORD ────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;

    if (!token || !new_password) {
      return apiResponse(res, { status: 400, success: false, error: 'Token and new password are required' });
    }

    if (new_password.length < 8 || !/[A-Z]/.test(new_password) || !/[0-9]/.test(new_password)) {
      return apiResponse(res, { status: 400, success: false, error: 'Password must be at least 8 characters with 1 uppercase and 1 number' });
    }

    const tokenDoc = await EmailVerification.findOne({
      token_hash: hashToken(token),
      type: 'password_reset',
      used_at: null,
    });

    if (!tokenDoc || tokenDoc.expires_at < new Date()) {
      return apiResponse(res, { status: 400, success: false, error: 'Invalid or expired reset token' });
    }

    tokenDoc.used_at = new Date();
    await tokenDoc.save();

    const user = await User.findById(tokenDoc.user_id);
    user.password_hash = new_password; // Pre-save hook hashes
    await user.save();

    // Invalidate all refresh tokens
    await RefreshToken.updateMany(
      { user_id: user._id, revoked_at: null },
      { revoked_at: new Date() }
    );

    return apiResponse(res, { data: { message: 'Password reset successful. Please log in.' } });
  } catch (error) {
    console.error('Reset password error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Password reset failed' });
  }
});

// ─── GET CURRENT USER ──────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = req.user.toSafeJSON();
    const tenant = req.tenant || null;

    // Check if WhatsApp account is connected
    let whatsapp_account = null;
    if (tenant) {
      const WhatsAppAccount = require('../models/WhatsAppAccount');
      const wa = await WhatsAppAccount.findOne({ tenant_id: tenant._id }).select('-access_token_encrypted');
      if (wa) whatsapp_account = wa;
    }

    return apiResponse(res, { data: { user, tenant, whatsapp_account } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch user' });
  }
});

// ─── CHECK EMAIL AVAILABILITY ──────────────────────────────
router.get('/check-email', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email || !validator.isEmail(email)) {
      return apiResponse(res, { data: { available: false } });
    }
    const exists = await User.findOne({ email: email.toLowerCase() });
    return apiResponse(res, { data: { available: !exists } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Check failed' });
  }
});

module.exports = router;
