const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  perMessageDeflate: true,
  pingInterval: 25000,
  pingTimeout: 60000,
});

const PORT = process.env.PORT || 3000;
const CONTROLLER_PASSWORD = process.env.CONTROLLER_PASS || 'crowdlight2024';

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// --- State ---
const zones = new Map(); // zoneName -> Set of socket ids
const clients = new Map(); // socket id -> { zone, connectedAt }
let currentState = { c: '#000000', e: 'solid', d: 500 }; // color, effect, duration
const zoneStates = new Map(); // zoneName -> { c, e, d }
let connectedCount = 0;

// --- API endpoint for stats ---
app.get('/api/stats', (req, res) => {
  const zoneStats = {};
  for (const [name, members] of zones) {
    zoneStats[name] = members.size;
  }
  res.json({ total: connectedCount, zones: zoneStats });
});

// --- Audience namespace ---
const audience = io.of('/audience');

audience.on('connection', (socket) => {
  connectedCount++;
  clients.set(socket.id, { zone: null, connectedAt: Date.now() });

  // Send current state immediately
  socket.emit('color', currentState);

  // Notify controllers
  io.of('/controller').emit('stats', getStats());

  // Join a zone
  socket.on('join-zone', (zoneName) => {
    if (!zoneName || typeof zoneName !== 'string') return;
    const sanitized = zoneName.trim().substring(0, 50);
    const client = clients.get(socket.id);
    if (!client) return;

    // Leave old zone
    if (client.zone) {
      const oldZone = zones.get(client.zone);
      if (oldZone) {
        oldZone.delete(socket.id);
        if (oldZone.size === 0) zones.delete(client.zone);
      }
      socket.leave(`zone:${client.zone}`);
    }

    // Join new zone
    client.zone = sanitized;
    if (!zones.has(sanitized)) zones.set(sanitized, new Set());
    zones.get(sanitized).add(socket.id);
    socket.join(`zone:${sanitized}`);

    // Send zone-specific state if exists
    const zoneState = zoneStates.get(sanitized);
    if (zoneState) socket.emit('color', zoneState);

    io.of('/controller').emit('stats', getStats());
  });

  socket.on('disconnect', () => {
    connectedCount--;
    const client = clients.get(socket.id);
    if (client && client.zone) {
      const zone = zones.get(client.zone);
      if (zone) {
        zone.delete(socket.id);
        if (zone.size === 0) zones.delete(client.zone);
      }
    }
    clients.delete(socket.id);
    io.of('/controller').emit('stats', getStats());
  });
});

// --- Controller namespace ---
const controller = io.of('/controller');

controller.use((socket, next) => {
  const pass = socket.handshake.auth.password;
  if (pass === CONTROLLER_PASSWORD) {
    next();
  } else {
    next(new Error('Password non valida'));
  }
});

controller.on('connection', (socket) => {
  // Send current state and stats
  socket.emit('stats', getStats());
  socket.emit('current-state', { global: currentState, zones: Object.fromEntries(zoneStates) });

  // Broadcast color to ALL audience
  socket.on('color-all', (data) => {
    if (!data || !data.c) return;
    const state = {
      c: String(data.c).substring(0, 7),
      e: ['solid', 'fade', 'pulse', 'strobe'].includes(data.e) ? data.e : 'solid',
      d: Math.min(Math.max(Number(data.d) || 500, 50), 5000),
    };
    currentState = state;
    audience.volatile.emit('color', state);
  });

  // Broadcast color to a specific ZONE
  socket.on('color-zone', (data) => {
    if (!data || !data.c || !data.zone) return;
    const state = {
      c: String(data.c).substring(0, 7),
      e: ['solid', 'fade', 'pulse', 'strobe'].includes(data.e) ? data.e : 'solid',
      d: Math.min(Math.max(Number(data.d) || 500, 50), 5000),
    };
    const zoneName = String(data.zone).trim().substring(0, 50);
    zoneStates.set(zoneName, state);
    audience.to(`zone:${zoneName}`).volatile.emit('color', state);
  });

  // Blackout - all phones to black
  socket.on('blackout', () => {
    const state = { c: '#000000', e: 'solid', d: 0 };
    currentState = state;
    zoneStates.clear();
    audience.volatile.emit('color', state);
  });

  // Sequence - series of timed color changes
  socket.on('sequence', (data) => {
    if (!Array.isArray(data.steps)) return;
    let delay = 0;
    for (const step of data.steps.slice(0, 100)) {
      const state = {
        c: String(step.c || '#000000').substring(0, 7),
        e: ['solid', 'fade', 'pulse', 'strobe'].includes(step.e) ? step.e : 'solid',
        d: Math.min(Math.max(Number(step.d) || 500, 50), 5000),
      };
      setTimeout(() => {
        currentState = state;
        if (step.zone) {
          audience.to(`zone:${step.zone}`).volatile.emit('color', state);
        } else {
          audience.volatile.emit('color', state);
        }
      }, delay);
      delay += Number(step.wait) || 1000;
    }
  });
});

function getStats() {
  const zoneStats = {};
  for (const [name, members] of zones) {
    zoneStats[name] = members.size;
  }
  return { total: connectedCount, zones: zoneStats };
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CrowdLight server running on http://localhost:${PORT}`);
  console.log(`Controller: http://localhost:${PORT}/controller.html`);
  console.log(`Controller password: ${CONTROLLER_PASSWORD}`);
});
