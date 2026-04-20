/**
 * Notification Service
 *
 * Wraps Notification.create() to automatically emit WebSocket events
 * to the tenant room, so the frontend receives real-time updates
 * without polling.
 */

const Notification = require('../models/Notification');
const { emitToTenant } = require('./socketService');

/**
 * Create a notification and emit it via WebSocket.
 *
 * @param {object} data - Notification fields (tenant_id, type, title, message, source, severity, etc.)
 * @returns {Promise<object>} The created notification document
 */
const createNotification = async (data) => {
  const notification = await Notification.create(data);

  // Emit real-time event to the tenant
  if (data.tenant_id) {
    emitToTenant(String(data.tenant_id), 'notification:new', {
      _id: notification._id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      source: notification.source,
      severity: notification.severity,
      read: false,
      created_at: notification.created_at,
    });
  }

  return notification;
};

module.exports = { createNotification };
