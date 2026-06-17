const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { USER_ROLE } = require('../config/constants');

class RealtimeService {
  static wss = null;
  static userSockets = new Map();
  static adminSockets = new Set();
  static initialized = false;

  static init(server) {
    if (this.initialized) return this.wss;

    this.wss = new WebSocket.Server({ server, path: '/ws' });
    this.initialized = true;

    this.wss.on('connection', async (ws, req) => {
      try {
        const token = this._extractToken(req);
        if (!token) {
          ws.close(4001, '未提供认证Token');
          return;
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('id role username');
        if (!user) {
          ws.close(4002, '用户不存在');
          return;
        }

        ws.userId = user._id.toString();
        ws.userRole = user.role;
        ws.isAlive = true;

        if (user.role === USER_ROLE.ADMIN) {
          this.adminSockets.add(ws);
        }

        if (!this.userSockets.has(ws.userId)) {
          this.userSockets.set(ws.userId, new Set());
        }
        this.userSockets.get(ws.userId).add(ws);

        ws.on('pong', () => {
          ws.isAlive = true;
        });

        ws.on('message', async (raw) => {
          try {
            const data = JSON.parse(raw.toString());
            if (data.type === 'ping') {
              ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            }
          } catch (_) {}
        });

        ws.on('close', () => {
          const sockets = this.userSockets.get(ws.userId);
          if (sockets) {
            sockets.delete(ws);
            if (sockets.size === 0) this.userSockets.delete(ws.userId);
          }
          this.adminSockets.delete(ws);
        });

        ws.send(JSON.stringify({
          type: 'connected',
          payload: { userId: user._id, role: user.role, timestamp: Date.now() },
        }));
      } catch (err) {
        try { ws.close(4003, `认证失败: ${err.message}`); } catch (_) {}
      }
    });

    const heartbeat = setInterval(() => {
      this.wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        try { ws.ping(); } catch (_) {}
      });
    }, 30000);

    this.wss.on('close', () => {
      clearInterval(heartbeat);
    });

    console.log('[Realtime] WebSocket服务已启动 /ws');
    return this.wss;
  }

  static _extractToken(req) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    if (query.get('token')) return query.get('token');
    const auth = req.headers && req.headers['sec-websocket-protocol'];
    if (auth && auth.startsWith('token.')) return auth.slice(6);
    const header = req.headers && req.headers.authorization;
    if (header && header.startsWith('Bearer ')) return header.slice(7);
    return null;
  }

  static _send(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
        return true;
      } catch (_) {}
    }
    return false;
  }

  static emitToUser(userId, message) {
    const id = userId && userId.toString ? userId.toString() : String(userId);
    const sockets = this.userSockets.get(id);
    if (!sockets || sockets.size === 0) return 0;
    let count = 0;
    const payload = {
      ...message,
      timestamp: message.timestamp || Date.now(),
    };
    sockets.forEach(ws => {
      if (this._send(ws, payload)) count++;
    });
    return count;
  }

  static emitToAdmins(message) {
    if (this.adminSockets.size === 0) return 0;
    let count = 0;
    const payload = {
      ...message,
      timestamp: message.timestamp || Date.now(),
    };
    this.adminSockets.forEach(ws => {
      if (this._send(ws, payload)) count++;
    });
    return count;
  }

  static broadcast(message) {
    if (!this.wss) return 0;
    let count = 0;
    const payload = {
      ...message,
      timestamp: message.timestamp || Date.now(),
    };
    this.wss.clients.forEach(ws => {
      if (this._send(ws, payload)) count++;
    });
    return count;
  }

  static broadcastOrderEvent(order, event, extra = {}) {
    const payload = {
      type: `order.${event}`,
      payload: {
        orderId: order._id || order.id,
        orderNo: order.orderNo,
        status: order.status,
        ...extra,
      },
    };
    this.emitToUser(order.user || (order.user && order.user._id), payload);
    this.emitToAdmins(payload);
  }

  static broadcastDamageEvent(report, event, extra = {}) {
    const payload = {
      type: `damage.${event}`,
      payload: {
        reportId: report._id || report.id,
        reportNo: report.reportNo,
        status: report.status,
        ...extra,
      },
    };
    this.emitToUser(report.user || (report.user && report.user._id), payload);
    this.emitToAdmins(payload);
  }

  static broadcastPaymentEvent(userId, event, extra = {}) {
    const payload = {
      type: `payment.${event}`,
      payload: { userId, ...extra },
    };
    this.emitToUser(userId, payload);
  }

  static getStats() {
    return {
      connectedUsers: this.userSockets.size,
      connectedAdmins: this.adminSockets.size,
      totalConnections: this.wss ? this.wss.clients.size : 0,
    };
  }
}

module.exports = RealtimeService;
