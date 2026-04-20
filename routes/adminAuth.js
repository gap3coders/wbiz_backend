const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const AdminUser = require('../models/AdminUser');
const { authenticateAdmin } = require('../middleware/adminAuth');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

/* POST /login */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return apiResponse(res, { status: 400, success: false, error: 'Email and password are required' });
    }

    const admin = await AdminUser.findOne({ email: email.toLowerCase().trim() });
    if (!admin) {
      return apiResponse(res, { status: 401, success: false, error: 'Invalid credentials' });
    }
    if (admin.status === 'suspended') {
      return apiResponse(res, { status: 403, success: false, error: 'Account suspended' });
    }
    if (admin.locked_until && admin.locked_until > new Date()) {
      return apiResponse(res, { status: 429, success: false, error: 'Account locked. Try again later.' });
    }

    const valid = await admin.comparePassword(password);
    if (!valid) {
      admin.login_attempts = (admin.login_attempts || 0) + 1;
      if (admin.login_attempts >= 5) {
        admin.locked_until = new Date(Date.now() + 15 * 60 * 1000);
      }
      await admin.save();
      return apiResponse(res, { status: 401, success: false, error: 'Invalid credentials' });
    }

    // Reset login attempts
    admin.login_attempts = 0;
    admin.locked_until = null;
    admin.last_login_at = new Date();
    await admin.save();

    const accessToken = jwt.sign(
      { adminId: admin._id, isAdmin: true, role: admin.role },
      config.jwt.secret,
      { expiresIn: config.jwt.accessExpiry || '15m' }
    );

    const refreshToken = jwt.sign(
      { adminId: admin._id, isAdmin: true },
      config.jwt.refreshSecret,
      { expiresIn: config.jwt.refreshExpiry || '30d' }
    );

    res.cookie('admin_access_token', accessToken, {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000,
      path: '/',
    });
    res.cookie('admin_refresh_token', refreshToken, {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    return apiResponse(res, {
      data: { admin: admin.toSafeJSON(), access_token: accessToken },
    });
  } catch (error) {
    console.error('[AdminAuth][Login]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Login failed' });
  }
});

/* POST /refresh */
router.post('/refresh', async (req, res) => {
  try {
    const token = req.cookies?.admin_refresh_token;
    if (!token) return apiResponse(res, { status: 401, success: false, error: 'Refresh token required' });

    const decoded = jwt.verify(token, config.jwt.refreshSecret);
    if (!decoded.isAdmin) return apiResponse(res, { status: 401, success: false, error: 'Invalid token' });

    const admin = await AdminUser.findById(decoded.adminId);
    if (!admin || admin.status === 'suspended') {
      return apiResponse(res, { status: 401, success: false, error: 'Account not found or suspended' });
    }

    const accessToken = jwt.sign(
      { adminId: admin._id, isAdmin: true, role: admin.role },
      config.jwt.secret,
      { expiresIn: config.jwt.accessExpiry || '15m' }
    );

    res.cookie('admin_access_token', accessToken, {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000,
      path: '/',
    });

    return apiResponse(res, { data: { admin: admin.toSafeJSON(), access_token: accessToken } });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return apiResponse(res, { status: 401, success: false, error: 'Refresh token expired' });
    }
    return apiResponse(res, { status: 401, success: false, error: 'Invalid refresh token' });
  }
});

/* GET /me */
router.get('/me', authenticateAdmin, async (req, res) => {
  return apiResponse(res, { data: { admin: req.admin.toSafeJSON() } });
});

/* POST /logout */
router.post('/logout', (req, res) => {
  res.clearCookie('admin_access_token', { path: '/' });
  res.clearCookie('admin_refresh_token', { path: '/' });
  return apiResponse(res, { data: { message: 'Logged out' } });
});

module.exports = router;
