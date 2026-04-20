const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const apiKeyAuth = require('./apiKeyAuth');

/**
 * Authenticate request via API key (X-API-Key header), httpOnly cookie, or Bearer header.
 * API key is checked first. If no X-API-Key header, falls through to JWT auth.
 */
const authenticate = async (req, res, next) => {
  // If X-API-Key header is present, delegate to API key auth
  if (req.headers['x-api-key']) {
    return apiKeyAuth(req, res, next);
  }

  try {
    const token =
      req.cookies?.access_token ||
      (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null);

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required',
      });
    }
    const decoded = jwt.verify(token, config.jwt.secret);

    const user = await User.findById(decoded.userId).select('-password_hash');
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User not found',
      });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Account suspended. Please contact support.',
      });
    }

    req.user = user;

    // Load tenant if user has one
    if (user.tenant_id) {
      const tenant = await Tenant.findById(user.tenant_id);
      req.tenant = tenant;
    }

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Access token expired',
        code: 'TOKEN_EXPIRED',
      });
    }
    return res.status(401).json({
      success: false,
      error: 'Invalid access token',
    });
  }
};

/**
 * Require specific user status
 */
const requireStatus = (...statuses) => {
  return (req, res, next) => {
    if (!statuses.includes(req.user.status)) {
      return res.status(403).json({
        success: false,
        error: `This action requires account status: ${statuses.join(' or ')}`,
      });
    }
    next();
  };
};

/**
 * Require specific role
 */
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
      });
    }
    next();
  };
};

/**
 * Require a specific permission.
 * JWT-authenticated users (full users) are always allowed.
 * API key users must have the permission in their permissions array.
 */
const requirePermission = (permission) => {
  return (req, res, next) => {
    // JWT users (full users) have all permissions
    if (req.user.role !== 'api_key') return next();

    // API key users — check permissions array
    if (req.user.permissions && req.user.permissions.includes(permission)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: `API key missing required permission: ${permission}`,
    });
  };
};

module.exports = { authenticate, requireStatus, requireRole, requirePermission };
