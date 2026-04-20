const jwt = require('jsonwebtoken');
const config = require('../config');
const AdminUser = require('../models/AdminUser');

/**
 * Authenticate admin request via httpOnly cookie (admin_access_token) or Bearer header.
 */
const authenticateAdmin = async (req, res, next) => {
  try {
    const token =
      req.cookies?.admin_access_token ||
      (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null);

    if (!token) {
      return res.status(401).json({ success: false, error: 'Admin access token required' });
    }

    const decoded = jwt.verify(token, config.jwt.secret);
    if (!decoded.isAdmin) {
      return res.status(401).json({ success: false, error: 'Invalid admin token' });
    }

    const admin = await AdminUser.findById(decoded.adminId).select('-password_hash');
    if (!admin) {
      return res.status(401).json({ success: false, error: 'Admin user not found' });
    }
    if (admin.status === 'suspended') {
      return res.status(403).json({ success: false, error: 'Admin account suspended' });
    }

    req.admin = admin;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Admin token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, error: 'Invalid admin token' });
  }
};

/**
 * Require specific admin role
 */
const requireAdminRole = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.admin.role)) {
      return res.status(403).json({ success: false, error: 'Insufficient admin permissions' });
    }
    next();
  };
};

module.exports = { authenticateAdmin, requireAdminRole };
