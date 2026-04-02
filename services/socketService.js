let Server = null;
try {
  Server = require('socket.io').Server;
} catch {
  Server = null;
}
const jwt = require('jsonwebtoken');
const config = require('../config');

let io = null;

const roomForTenant = (tenantId) => `tenant:${tenantId}`;

const initializeSocketServer = (httpServer) => {
  if (!Server) {
    if (config.verboseLogs) console.log('[Socket] socket.io not installed; socket server disabled');
    return null;
  }
  io = new Server(httpServer, {
    cors: {
      origin: config.frontendUrls || config.frontendUrl,
      credentials: true,
      methods: ['GET', 'POST'],
    },
  });

  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
        socket.handshake.query?.token;

      if (!token) {
        return next(new Error('Authentication token required'));
      }

      const decoded = jwt.verify(token, config.jwt.secret);
      socket.user = decoded;
      return next();
    } catch (error) {
      return next(new Error('Invalid socket token'));
    }
  });

  io.on('connection', (socket) => {
    const tenantId = socket.user?.tenantId;
    if (tenantId) {
      socket.join(roomForTenant(tenantId));
    }

    socket.emit('portal:connected', {
      tenantId: tenantId || null,
      connectedAt: new Date().toISOString(),
    });
  });

  if (config.verboseLogs) {
    console.log('[Socket] Socket server initialized');
  }
  return io;
};

const emitToTenant = (tenantId, event, payload) => {
  if (!io || !tenantId) return;
  io.to(roomForTenant(String(tenantId))).emit(event, payload);
};

const getSocketServer = () => io;

module.exports = {
  initializeSocketServer,
  emitToTenant,
  getSocketServer,
};
