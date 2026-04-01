const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const dgram = require('dgram');
const { stmts } = require('./db');
const { setupAuthRoutes, verifyToken } = require('./auth');
const { setupEventRoutes } = require('./routes/events');
const { setupTunnelRoutes } = require('./tunnel');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  perMessageDeflate: true,
  pingInterval: 25000,
  pingTimeout: 60000,
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// ============ EVENT MANAGER ============
class EventState {
  constructor(slug, name, numGroups, controllerToken) {
    this.slug = slug;
    this.name = name;
    this.numGroups = numGroups;
    this.controllerToken = controllerToken;
    this.groups = new Map();
    this.clients = new Map();
    this.groupStates = new Map();
    this.connectedCount = 0;
    this.seqTimers = [];
    this.artnet = {
      active: false, socket: null, universe: 0, startChannel: 1,
      sourceIp: null, packetsTotal: 0, packetsPerSec: 0,
      lastCountReset: Date.now(), packetsSinceReset: 0,
      lastSent: {}, lastSendTime: 0, throttleMs: 33,
      dmxValues: {}, statusInterval: null,
    };

    for (let i = 1; i <= numGroups; i++) {
      this.groups.set(i, new Set());
      this.groupStates.set(i, { c: '#000000', e: 'solid', d: 500 });
      this.artnet.lastSent[i] = '#000000';
      this.artnet.dmxValues[i] = { r: 0, g: 0, b: 0, hex: '#000000' };
    }
  }

  assignGroup() {
    let minSize = Infinity;
    for (const [, members] of this.groups) {
      if (members.size < minSize) minSize = members.size;
    }
    const candidates = [];
    for (const [id, members] of this.groups) {
      if (members.size === minSize) candidates.push(id);
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  getStats() {
    const groupStats = {};
    for (let i = 1; i <= this.numGroups; i++) {
      groupStats[i] = this.groups.get(i).size;
    }
    return { total: this.connectedCount, groups: groupStats, numGroups: this.numGroups };
  }

  clearSeqTimers() {
    for (const t of this.seqTimers) clearTimeout(t);
    this.seqTimers = [];
  }
}

// Active event states in memory
const eventStates = new Map(); // slug -> EventState

function getOrCreateEventState(slug) {
  if (eventStates.has(slug)) return eventStates.get(slug);
  const event = stmts.getEventBySlug.get(slug);
  if (!event || !event.is_active) return null;
  const state = new EventState(slug, event.name, event.num_groups, event.controller_token);
  eventStates.set(slug, state);
  return state;
}

function getEventStats(slug) {
  const state = eventStates.get(slug);
  return state ? state.getStats() : { total: 0, groups: {}, numGroups: 10 };
}

function sanitizeState(data) {
  return {
    c: String(data.c || '#000000').substring(0, 7),
    e: ['solid', 'fade', 'pulse', 'strobe'].includes(data.e) ? data.e : 'solid',
    d: Math.min(Math.max(Number(data.d) || 500, 50), 5000),
  };
}

// ============ ROUTES ============
setupAuthRoutes(app);
setupEventRoutes(app, getEventStats);
setupTunnelRoutes(app, PORT);

// Page routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/event/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'event.html')));
app.get('/event/:slug/control', (req, res) => res.sendFile(path.join(__dirname, 'public', 'controller.html')));

// Static files (after page routes to avoid conflicts)
app.use(express.static(path.join(__dirname, 'public')));

// ============ AUDIENCE NAMESPACE ============
const audience = io.of('/audience');

audience.on('connection', (socket) => {
  const slug = socket.handshake.auth.slug;
  if (!slug) return socket.disconnect();

  const state = getOrCreateEventState(slug);
  if (!state) {
    socket.emit('error', { message: 'Evento non trovato o non attivo' });
    return socket.disconnect();
  }

  state.connectedCount++;
  const groupId = state.assignGroup();
  state.clients.set(socket.id, { group: groupId, connectedAt: Date.now() });
  state.groups.get(groupId).add(socket.id);
  socket.join(`${slug}:group:${groupId}`);
  socket.join(`${slug}:all`);

  socket.emit('assigned', { group: groupId, total: state.numGroups });
  const currentGroupState = state.groupStates.get(groupId);
  if (currentGroupState) socket.emit('color', currentGroupState);

  // Notify controllers of this event
  controller.to(`ctrl:${slug}`).emit('stats', state.getStats());

  socket.on('disconnect', () => {
    state.connectedCount--;
    const client = state.clients.get(socket.id);
    if (client) {
      const group = state.groups.get(client.group);
      if (group) group.delete(socket.id);
    }
    state.clients.delete(socket.id);
    controller.to(`ctrl:${slug}`).emit('stats', state.getStats());

    // Cleanup empty event states after a delay
    if (state.connectedCount <= 0) {
      setTimeout(() => {
        const current = eventStates.get(slug);
        if (current && current.connectedCount <= 0 && current.clients.size === 0) {
          eventStates.delete(slug);
        }
      }, 60000);
    }
  });
});

// ============ CONTROLLER NAMESPACE ============
const controller = io.of('/controller');

controller.use((socket, next) => {
  const { token, slug } = socket.handshake.auth;
  if (!token || !slug) return next(new Error('Token e slug richiesti'));

  const event = stmts.getEventBySlug.get(slug);
  if (!event) return next(new Error('Evento non trovato'));
  if (event.controller_token !== token) return next(new Error('Token non valido'));
  if (!event.is_active) return next(new Error('Evento non attivo'));

  socket.eventSlug = slug;
  socket.eventData = event;
  next();
});

controller.on('connection', (socket) => {
  const slug = socket.eventSlug;
  const state = getOrCreateEventState(slug);
  if (!state) return socket.disconnect();

  socket.join(`ctrl:${slug}`);

  // Send current state
  socket.emit('stats', state.getStats());
  const allStates = {};
  for (let i = 1; i <= state.numGroups; i++) {
    allStates[i] = state.groupStates.get(i);
  }
  socket.emit('current-state', { groups: allStates, numGroups: state.numGroups });

  // Color to ALL groups
  socket.on('color-all', (data) => {
    if (!data || !data.c) return;
    const st = sanitizeState(data);
    for (let i = 1; i <= state.numGroups; i++) state.groupStates.set(i, st);
    audience.to(`${slug}:all`).volatile.emit('color', st);
    controller.to(`ctrl:${slug}`).emit('group-update', { group: 'all', state: st });
  });

  // Color to specific group
  socket.on('color-group', (data) => {
    if (!data || !data.c || !data.group) return;
    const groupId = Number(data.group);
    if (groupId < 1 || groupId > state.numGroups) return;
    const st = sanitizeState(data);
    state.groupStates.set(groupId, st);
    audience.to(`${slug}:group:${groupId}`).volatile.emit('color', st);
    controller.to(`ctrl:${slug}`).emit('group-update', { group: groupId, state: st });
  });

  // Batch update
  socket.on('color-batch', (data) => {
    if (!Array.isArray(data.groups)) return;
    for (const item of data.groups) {
      const groupId = Number(item.group);
      if (groupId < 1 || groupId > state.numGroups) continue;
      const st = sanitizeState(item);
      state.groupStates.set(groupId, st);
      audience.to(`${slug}:group:${groupId}`).volatile.emit('color', st);
    }
    const allStates = {};
    for (let i = 1; i <= state.numGroups; i++) allStates[i] = state.groupStates.get(i);
    controller.to(`ctrl:${slug}`).emit('state-sync', allStates);
  });

  // Blackout
  socket.on('blackout', () => {
    const st = { c: '#000000', e: 'solid', d: 0 };
    for (let i = 1; i <= state.numGroups; i++) state.groupStates.set(i, st);
    audience.to(`${slug}:all`).volatile.emit('color', st);
    controller.to(`ctrl:${slug}`).emit('group-update', { group: 'all', state: st });
  });

  // Sequence
  function executeStep(step) {
    const st = sanitizeState(step);
    const targetGroups = Array.isArray(step.groups) ? step.groups : [Number(step.group) || 0];
    const isAll = targetGroups.includes(0);
    if (isAll) {
      for (let i = 1; i <= state.numGroups; i++) state.groupStates.set(i, st);
      audience.to(`${slug}:all`).volatile.emit('color', st);
      controller.to(`ctrl:${slug}`).emit('group-update', { group: 'all', state: st });
    } else {
      for (const gId of targetGroups) {
        const groupId = Number(gId);
        if (groupId >= 1 && groupId <= state.numGroups) {
          state.groupStates.set(groupId, st);
          audience.to(`${slug}:group:${groupId}`).volatile.emit('color', st);
        }
      }
      const allStates = {};
      for (let i = 1; i <= state.numGroups; i++) allStates[i] = state.groupStates.get(i);
      controller.to(`ctrl:${slug}`).emit('state-sync', allStates);
    }
  }

  function playSequence(steps, loop) {
    state.clearSeqTimers();
    let delay = 0;
    const totalDuration = steps.reduce((sum, s) => sum + (Number(s.wait) || 1000), 0);
    for (const step of steps.slice(0, 100)) {
      const t = setTimeout(() => executeStep(step), delay);
      state.seqTimers.push(t);
      delay += Number(step.wait) || 1000;
    }
    if (loop) {
      const t = setTimeout(() => playSequence(steps, true), totalDuration);
      state.seqTimers.push(t);
    }
  }

  socket.on('sequence', (data) => {
    if (!Array.isArray(data.steps)) return;
    playSequence(data.steps, !!data.loop);
  });

  socket.on('stop-sequence', () => {
    state.clearSeqTimers();
  });

  // ============ ARTNET (per-event) ============
  socket.emit('artnet-status', getArtNetStatus(state));

  socket.on('artnet-start', () => startArtNet(state, slug));
  socket.on('artnet-stop', () => stopArtNet(state));
  socket.on('artnet-config', (data) => {
    if (data.universe !== undefined) state.artnet.universe = Number(data.universe) || 0;
    if (data.startChannel !== undefined) state.artnet.startChannel = Math.max(1, Number(data.startChannel) || 1);
    for (let i = 1; i <= state.numGroups; i++) state.artnet.lastSent[i] = '';
    controller.to(`ctrl:${slug}`).emit('artnet-status', getArtNetStatus(state));
  });
});

// ============ ARTNET FUNCTIONS ============
const CHANNELS_PER_GROUP = 3;

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function getArtNetStatus(state) {
  return {
    active: state.artnet.active,
    universe: state.artnet.universe,
    startChannel: state.artnet.startChannel,
    sourceIp: state.artnet.sourceIp,
    packetsPerSec: state.artnet.packetsPerSec,
    packetsTotal: state.artnet.packetsTotal,
    dmxValues: state.artnet.dmxValues,
  };
}

function startArtNet(state, slug) {
  if (state.artnet.active) return;
  const totalChannels = state.numGroups * CHANNELS_PER_GROUP;

  state.artnet.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  state.artnet.socket.on('message', (msg) => {
    if (msg.length < 18) return;
    if (msg.toString('ascii', 0, 7) !== 'Art-Net') return;
    if (msg.readUInt16LE(8) !== 0x5000) return;

    const subUni = msg.readUInt8(14);
    const net = msg.readUInt8(15);
    if (((net << 8) | subUni) !== state.artnet.universe) return;

    const dmxLength = msg.readUInt16BE(16);
    const dmxData = msg.slice(18, 18 + dmxLength);
    const ch = state.artnet.startChannel - 1;
    if (dmxData.length < ch + totalChannels) return;

    state.artnet.packetsTotal++;
    state.artnet.packetsSinceReset++;

    const now = Date.now();
    if (now - state.artnet.lastSendTime < state.artnet.throttleMs) return;

    const updates = [];
    for (let i = 0; i < state.numGroups; i++) {
      const offset = ch + i * CHANNELS_PER_GROUP;
      const r = dmxData[offset], g = dmxData[offset + 1], b = dmxData[offset + 2];
      const color = rgbToHex(r, g, b);
      const groupId = i + 1;
      state.artnet.dmxValues[groupId] = { r, g, b, hex: color };
      if (color !== state.artnet.lastSent[groupId]) {
        updates.push({ group: groupId, c: color, e: 'solid', d: 100 });
        state.artnet.lastSent[groupId] = color;
      }
    }

    if (updates.length === 0) return;
    state.artnet.lastSendTime = now;

    const allSame = updates.length === state.numGroups && updates.every(u => u.c === updates[0].c);
    if (allSame) {
      const st = { c: updates[0].c, e: 'solid', d: 100 };
      for (let i = 1; i <= state.numGroups; i++) state.groupStates.set(i, st);
      audience.to(`${slug}:all`).volatile.emit('color', st);
      controller.to(`ctrl:${slug}`).emit('group-update', { group: 'all', state: st });
    } else {
      for (const u of updates) {
        const st = { c: u.c, e: 'solid', d: 100 };
        state.groupStates.set(u.group, st);
        audience.to(`${slug}:group:${u.group}`).volatile.emit('color', st);
      }
      const allStates = {};
      for (let i = 1; i <= state.numGroups; i++) allStates[i] = state.groupStates.get(i);
      controller.to(`ctrl:${slug}`).emit('state-sync', allStates);
    }
  });

  state.artnet.socket.on('error', (err) => {
    controller.to(`ctrl:${slug}`).emit('artnet-status', { ...getArtNetStatus(state), active: false, error: err.message });
  });

  state.artnet.socket.bind(6454, '0.0.0.0', () => {
    state.artnet.active = true;
    controller.to(`ctrl:${slug}`).emit('artnet-status', getArtNetStatus(state));
  });

  state.artnet.statusInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - state.artnet.lastCountReset) / 1000;
    state.artnet.packetsPerSec = elapsed > 0 ? Math.round(state.artnet.packetsSinceReset / elapsed) : 0;
    state.artnet.packetsSinceReset = 0;
    state.artnet.lastCountReset = now;
    controller.to(`ctrl:${slug}`).emit('artnet-status', getArtNetStatus(state));
  }, 2000);
}

function stopArtNet(state) {
  if (!state.artnet.active) return;
  if (state.artnet.statusInterval) clearInterval(state.artnet.statusInterval);
  state.artnet.statusInterval = null;
  if (state.artnet.socket) { state.artnet.socket.close(); state.artnet.socket = null; }
  state.artnet.active = false;
  state.artnet.sourceIp = null;
  state.artnet.packetsPerSec = 0;
}

// ============ START ============
// Only auto-start if run directly (not imported by Electron)
function startServer(callback) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`CrowdLight running on http://localhost:${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
    if (callback) callback(PORT);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, server, startServer, PORT };
