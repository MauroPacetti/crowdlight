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

  // Sequence
  socket.on('sequence', (data) => {
    if (!Array.isArray(data.steps)) return;
    let delay = 0;
    for (const step of data.steps.slice(0, 100)) {
      const state = sanitizeState(step);
      const targetGroups = Array.isArray(step.groups) ? step.groups : [Number(step.group) || 0];
      setTimeout(() => {
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
          // Sync controller state
          const allStates = {};
          for (let i = 1; i <= NUM_GROUPS; i++) allStates[i] = groupStates.get(i);
          controller.emit('state-sync', allStates);
        }
      }, delay);
      delay += Number(step.wait) || 1000;
    }
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CrowdLight server running on http://localhost:${PORT}`);
  console.log(`Controller: http://localhost:${PORT}/controller.html`);
  console.log(`Groups: ${NUM_GROUPS}`);
  console.log(`Controller password: ${CONTROLLER_PASSWORD}`);
});
