const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const Tenant = require('../models/Tenant');

/**
 * Authenticate request via JWT Bearer token
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Access token required',
      });
    }

    const token = authHeader.split(' ')[1];
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

module.exports = { authenticate, requireStatus, requireRole };
