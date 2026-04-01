const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const dgram = require('dgram');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  perMessageDeflate: true,
  pingInterval: 25000,
  pingTimeout: 60000,
});

const PORT = process.env.PORT || 3000;
const CONTROLLER_PASSWORD = process.env.CONTROLLER_PASS || 'crowdlight2024';
const NUM_GROUPS = 10;

// Serve static files
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- State ---
const groups = new Map(); // groupId (1-10) -> Set of socket ids
const clients = new Map(); // socket id -> { group, connectedAt }
// Per-group color state
const groupStates = new Map(); // groupId -> { c, e, d }
let connectedCount = 0;

// Initialize groups
for (let i = 1; i <= NUM_GROUPS; i++) {
  groups.set(i, new Set());
  groupStates.set(i, { c: '#000000', e: 'solid', d: 500 });
}

// --- Random group assignment (balanced) ---
function assignGroup() {
  // Find group(s) with fewest members
  let minSize = Infinity;
  for (const [, members] of groups) {
    if (members.size < minSize) minSize = members.size;
  }
  // Collect groups with min size
  const candidates = [];
  for (const [id, members] of groups) {
    if (members.size === minSize) candidates.push(id);
  }
  // Pick random among smallest groups
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// --- API endpoint for stats ---
app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

// --- REST API for external control (ArtNet bridge, etc.) ---
app.post('/api/color', (req, res) => {
  const auth = req.headers['x-password'] || req.body.password;
  if (auth !== CONTROLLER_PASSWORD) {
    return res.status(401).json({ error: 'Password non valida' });
  }
  const data = req.body;
  const state = {
    c: String(data.c || '#000000').substring(0, 7),
    e: ['solid', 'fade', 'pulse', 'strobe'].includes(data.e) ? data.e : 'solid',
    d: Math.min(Math.max(Number(data.d) || 500, 50), 5000),
  };
  const groupId = Number(data.group);

  if (groupId >= 1 && groupId <= NUM_GROUPS) {
    groupStates.set(groupId, state);
    audience.to(`group:${groupId}`).volatile.emit('color', state);
  } else {
    // All groups
    for (let i = 1; i <= NUM_GROUPS; i++) {
      groupStates.set(i, state);
    }
    audience.volatile.emit('color', state);
  }
  res.json({ ok: true, state });
});

// Batch update: multiple groups at once (used by ArtNet bridge)
app.post('/api/color-batch', (req, res) => {
  const auth = req.headers['x-password'] || req.body.password;
  if (auth !== CONTROLLER_PASSWORD) {
    return res.status(401).json({ error: 'Password non valida' });
  }
  const updates = req.body.groups; // array of { group, c, e, d }
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'Invalid' });

  for (const data of updates) {
    const groupId = Number(data.group);
    if (groupId < 1 || groupId > NUM_GROUPS) continue;
    const state = {
      c: String(data.c || '#000000').substring(0, 7),
      e: ['solid', 'fade', 'pulse', 'strobe'].includes(data.e) ? data.e : 'solid',
      d: Math.min(Math.max(Number(data.d) || 500, 50), 5000),
    };
    groupStates.set(groupId, state);
    audience.to(`group:${groupId}`).volatile.emit('color', state);
  }
  res.json({ ok: true });
});

app.post('/api/blackout', (req, res) => {
  const auth = req.headers['x-password'] || req.body.password;
  if (auth !== CONTROLLER_PASSWORD) {
    return res.status(401).json({ error: 'Password non valida' });
  }
  const state = { c: '#000000', e: 'solid', d: 0 };
  for (let i = 1; i <= NUM_GROUPS; i++) {
    groupStates.set(i, state);
  }
  audience.volatile.emit('color', state);
  res.json({ ok: true });
});

// --- Audience namespace ---
const audience = io.of('/audience');

audience.on('connection', (socket) => {
  connectedCount++;

  // Assign random group (balanced)
  const groupId = assignGroup();
  clients.set(socket.id, { group: groupId, connectedAt: Date.now() });
  groups.get(groupId).add(socket.id);
  socket.join(`group:${groupId}`);

  // Send group assignment and current state
  socket.emit('assigned', { group: groupId, total: NUM_GROUPS });
  const currentGroupState = groupStates.get(groupId);
  if (currentGroupState) socket.emit('color', currentGroupState);

  // Notify controllers
  io.of('/controller').emit('stats', getStats());

  socket.on('disconnect', () => {
    connectedCount--;
    const client = clients.get(socket.id);
    if (client) {
      const group = groups.get(client.group);
      if (group) group.delete(socket.id);
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
  const allStates = {};
  for (let i = 1; i <= NUM_GROUPS; i++) {
    allStates[i] = groupStates.get(i);
  }
  socket.emit('current-state', { groups: allStates, numGroups: NUM_GROUPS });

  // Color to ALL groups
  socket.on('color-all', (data) => {
    if (!data || !data.c) return;
    const state = sanitizeState(data);
    for (let i = 1; i <= NUM_GROUPS; i++) {
      groupStates.set(i, state);
    }
    audience.volatile.emit('color', state);
    controller.emit('group-update', { group: 'all', state });
  });

  // Color to a specific group
  socket.on('color-group', (data) => {
    if (!data || !data.c || !data.group) return;
    const groupId = Number(data.group);
    if (groupId < 1 || groupId > NUM_GROUPS) return;
    const state = sanitizeState(data);
    groupStates.set(groupId, state);
    audience.to(`group:${groupId}`).volatile.emit('color', state);
    controller.emit('group-update', { group: groupId, state });
  });

  // Batch update from controller
  socket.on('color-batch', (data) => {
    if (!Array.isArray(data.groups)) return;
    for (const item of data.groups) {
      const groupId = Number(item.group);
      if (groupId < 1 || groupId > NUM_GROUPS) continue;
      const state = sanitizeState(item);
      groupStates.set(groupId, state);
      audience.to(`group:${groupId}`).volatile.emit('color', state);
    }
    // Send full state update to all controllers
    const allStates = {};
    for (let i = 1; i <= NUM_GROUPS; i++) {
      allStates[i] = groupStates.get(i);
    }
    controller.emit('state-sync', allStates);
  });

  // Blackout
  socket.on('blackout', () => {
    const state = { c: '#000000', e: 'solid', d: 0 };
    for (let i = 1; i <= NUM_GROUPS; i++) {
      groupStates.set(i, state);
    }
    audience.volatile.emit('color', state);
    controller.emit('group-update', { group: 'all', state });
  });

  // Sequence (with loop support)
  let seqTimers = [];

  function clearSeqTimers() {
    for (const t of seqTimers) clearTimeout(t);
    seqTimers = [];
  }

  function executeStep(step) {
    const state = sanitizeState(step);
    const targetGroups = Array.isArray(step.groups) ? step.groups : [Number(step.group) || 0];
    const isAll = targetGroups.includes(0);
    if (isAll) {
      for (let i = 1; i <= NUM_GROUPS; i++) groupStates.set(i, state);
      audience.volatile.emit('color', state);
      controller.emit('group-update', { group: 'all', state });
    } else {
      for (const gId of targetGroups) {
        const groupId = Number(gId);
        if (groupId >= 1 && groupId <= NUM_GROUPS) {
          groupStates.set(groupId, state);
          audience.to(`group:${groupId}`).volatile.emit('color', state);
        }
      }
      const allStates = {};
      for (let i = 1; i <= NUM_GROUPS; i++) allStates[i] = groupStates.get(i);
      controller.emit('state-sync', allStates);
    }
  }

  function playSequence(steps, loop) {
    clearSeqTimers();
    let delay = 0;
    const totalDuration = steps.reduce((sum, s) => sum + (Number(s.wait) || 1000), 0);
    for (const step of steps.slice(0, 100)) {
      const t = setTimeout(() => executeStep(step), delay);
      seqTimers.push(t);
      delay += Number(step.wait) || 1000;
    }
    if (loop) {
      const t = setTimeout(() => playSequence(steps, true), totalDuration);
      seqTimers.push(t);
    }
  }

  socket.on('sequence', (data) => {
    if (!Array.isArray(data.steps)) return;
    playSequence(data.steps, !!data.loop);
  });

  socket.on('stop-sequence', () => {
    clearSeqTimers();
  });
});

function sanitizeState(data) {
  return {
    c: String(data.c || '#000000').substring(0, 7),
    e: ['solid', 'fade', 'pulse', 'strobe'].includes(data.e) ? data.e : 'solid',
    d: Math.min(Math.max(Number(data.d) || 500, 50), 5000),
  };
}

function getStats() {
  const groupStats = {};
  for (let i = 1; i <= NUM_GROUPS; i++) {
    groupStats[i] = groups.get(i).size;
  }
  return { total: connectedCount, groups: groupStats, numGroups: NUM_GROUPS };
}

// ============ INTEGRATED ARTNET BRIDGE ============
const CHANNELS_PER_GROUP = 3;
const TOTAL_CHANNELS = NUM_GROUPS * CHANNELS_PER_GROUP;

const artnet = {
  active: false,
  socket: null,
  universe: parseInt(process.env.ARTNET_UNIVERSE || '0'),
  startChannel: parseInt(process.env.ARTNET_START_CHANNEL || '1'),
  sourceIp: null,
  packetsTotal: 0,
  packetsPerSec: 0,
  lastCountReset: Date.now(),
  packetsSinceReset: 0,
  lastSent: {},
  lastSendTime: 0,
  throttleMs: 33,
  statusInterval: null,
  dmxValues: {}, // groupId -> { r, g, b, hex }
};
for (let i = 1; i <= NUM_GROUPS; i++) {
  artnet.lastSent[i] = '#000000';
  artnet.dmxValues[i] = { r: 0, g: 0, b: 0, hex: '#000000' };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function startArtNet() {
  if (artnet.active) return;

  artnet.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  artnet.socket.on('message', (msg, rinfo) => {
    if (msg.length < 18) return;
    if (msg.toString('ascii', 0, 7) !== 'Art-Net') return;
    if (msg.readUInt16LE(8) !== 0x5000) return;

    const subUni = msg.readUInt8(14);
    const net = msg.readUInt8(15);
    const universe = (net << 8) | subUni;
    if (universe !== artnet.universe) return;

    const dmxLength = msg.readUInt16BE(16);
    const dmxData = msg.slice(18, 18 + dmxLength);
    const ch = artnet.startChannel - 1; // 0-indexed
    if (dmxData.length < ch + TOTAL_CHANNELS) return;

    artnet.sourceIp = rinfo.address;
    artnet.packetsTotal++;
    artnet.packetsSinceReset++;

    // Throttle
    const now = Date.now();
    if (now - artnet.lastSendTime < artnet.throttleMs) return;

    const updates = [];
    for (let i = 0; i < NUM_GROUPS; i++) {
      const offset = ch + i * CHANNELS_PER_GROUP;
      const r = dmxData[offset];
      const g = dmxData[offset + 1];
      const b = dmxData[offset + 2];
      const color = rgbToHex(r, g, b);
      const groupId = i + 1;

      artnet.dmxValues[groupId] = { r, g, b, hex: color };

      if (color !== artnet.lastSent[groupId]) {
        updates.push({ group: groupId, c: color, e: 'solid', d: 100 });
        artnet.lastSent[groupId] = color;
      }
    }

    if (updates.length === 0) return;
    artnet.lastSendTime = now;

    const allSame = updates.length === NUM_GROUPS && updates.every(u => u.c === updates[0].c);
    if (allSame) {
      const state = { c: updates[0].c, e: 'solid', d: 100 };
      for (let i = 1; i <= NUM_GROUPS; i++) groupStates.set(i, state);
      audience.volatile.emit('color', state);
      controller.emit('group-update', { group: 'all', state });
    } else {
      for (const u of updates) {
        const state = { c: u.c, e: 'solid', d: 100 };
        groupStates.set(u.group, state);
        audience.to(`group:${u.group}`).volatile.emit('color', state);
      }
      const allStates = {};
      for (let i = 1; i <= NUM_GROUPS; i++) allStates[i] = groupStates.get(i);
      controller.emit('state-sync', allStates);
    }
  });

  artnet.socket.on('error', (err) => {
    console.error('ArtNet error:', err.message);
    controller.emit('artnet-status', { active: false, error: err.message });
  });

  artnet.socket.bind(6454, '0.0.0.0', () => {
    artnet.active = true;
    console.log('ArtNet listener started on port 6454');
    broadcastArtNetStatus();
  });

  // Status broadcast every 2s
  artnet.statusInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - artnet.lastCountReset) / 1000;
    artnet.packetsPerSec = elapsed > 0 ? Math.round(artnet.packetsSinceReset / elapsed) : 0;
    artnet.packetsSinceReset = 0;
    artnet.lastCountReset = now;
    broadcastArtNetStatus();
  }, 2000);
}

function stopArtNet() {
  if (!artnet.active) return;
  if (artnet.statusInterval) clearInterval(artnet.statusInterval);
  artnet.statusInterval = null;
  if (artnet.socket) {
    artnet.socket.close();
    artnet.socket = null;
  }
  artnet.active = false;
  artnet.sourceIp = null;
  artnet.packetsPerSec = 0;
  broadcastArtNetStatus();
  console.log('ArtNet listener stopped');
}

function broadcastArtNetStatus() {
  controller.emit('artnet-status', {
    active: artnet.active,
    universe: artnet.universe,
    startChannel: artnet.startChannel,
    sourceIp: artnet.sourceIp,
    packetsPerSec: artnet.packetsPerSec,
    packetsTotal: artnet.packetsTotal,
    dmxValues: artnet.dmxValues,
  });
}

// Add ArtNet control events to controller namespace
controller.on('connection', (socket) => {
  // Send current ArtNet status on connect
  socket.emit('artnet-status', {
    active: artnet.active,
    universe: artnet.universe,
    startChannel: artnet.startChannel,
    sourceIp: artnet.sourceIp,
    packetsPerSec: artnet.packetsPerSec,
    packetsTotal: artnet.packetsTotal,
    dmxValues: artnet.dmxValues,
  });

  socket.on('artnet-start', () => {
    startArtNet();
  });

  socket.on('artnet-stop', () => {
    stopArtNet();
  });

  socket.on('artnet-config', (data) => {
    if (data.universe !== undefined) artnet.universe = Number(data.universe) || 0;
    if (data.startChannel !== undefined) artnet.startChannel = Math.max(1, Number(data.startChannel) || 1);
    // Reset last sent to force re-send with new config
    for (let i = 1; i <= NUM_GROUPS; i++) artnet.lastSent[i] = '';
    broadcastArtNetStatus();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CrowdLight server running on http://localhost:${PORT}`);
  console.log(`Controller: http://localhost:${PORT}/controller.html`);
  console.log(`Groups: ${NUM_GROUPS}`);
  console.log(`Controller password: ${CONTROLLER_PASSWORD}`);
});
