const crypto = require('crypto');

/**
 * Generate a random token
 */
const generateToken = (length = 64) => {
  return crypto.randomBytes(length).toString('hex');
};

/**
 * Hash a token for storage
 */
const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

/**
 * Create URL-safe slug from company name
 */
const createSlug = (name) => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50) + '-' + crypto.randomBytes(3).toString('hex');
};

/**
 * Standard API response
 */
const apiResponse = (res, { status = 200, success = true, data = null, error = null, meta = null }) => {
  const response = { success };
  if (data !== null) response.data = data;
  if (error !== null) response.error = error;
  if (meta !== null) response.meta = meta;
  return res.status(status).json(response);
};

module.exports = { generateToken, hashToken, createSlug, apiResponse };
