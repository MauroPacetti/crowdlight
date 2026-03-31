#!/usr/bin/env node
/**
 * CrowdLight - ArtNet Bridge (10 Fixture Mode)
 *
 * Riceve dati ArtNet (DMX) e controlla 10 gruppi di telefoni come 10 fixture RGB.
 *
 * MAPPA DMX (30 canali totali):
 *   Gruppo 1:  CH 1-3   (R, G, B)
 *   Gruppo 2:  CH 4-6   (R, G, B)
 *   Gruppo 3:  CH 7-9   (R, G, B)
 *   Gruppo 4:  CH 10-12 (R, G, B)
 *   Gruppo 5:  CH 13-15 (R, G, B)
 *   Gruppo 6:  CH 16-18 (R, G, B)
 *   Gruppo 7:  CH 19-21 (R, G, B)
 *   Gruppo 8:  CH 22-24 (R, G, B)
 *   Gruppo 9:  CH 25-27 (R, G, B)
 *   Gruppo 10: CH 28-30 (R, G, B)
 *
 * UNIVERSO: configurabile (default: 0)
 * START CHANNEL: configurabile (default: 1)
 *
 * USO:
 *   set CROWDLIGHT_URL=https://crowdlight.onrender.com
 *   set CROWDLIGHT_PASS=tuapassword
 *   node artnet-bridge.js
 *
 * VARIABILI D'AMBIENTE:
 *   CROWDLIGHT_URL       - URL del server (default: https://crowdlight.onrender.com)
 *   CROWDLIGHT_PASS      - Password controller
 *   ARTNET_UNIVERSE      - Universo ArtNet (default: 0)
 *   ARTNET_START_CHANNEL - Canale iniziale (default: 1)
 *   ARTNET_INTERFACE     - Interfaccia di rete (default: 0.0.0.0)
 */

const dgram = require('dgram');
const { io } = require('socket.io-client');
const readline = require('readline');

// ============ CONFIGURAZIONE ============
const NUM_GROUPS = 10;
const CHANNELS_PER_GROUP = 3; // R, G, B
const TOTAL_CHANNELS = NUM_GROUPS * CHANNELS_PER_GROUP; // 30

const CONFIG = {
  serverUrl: process.env.CROWDLIGHT_URL || 'https://crowdlight.onrender.com',
  password: process.env.CROWDLIGHT_PASS || 'crowdlight2024',
  artnetPort: 6454,
  artnetInterface: process.env.ARTNET_INTERFACE || '0.0.0.0',
  universe: parseInt(process.env.ARTNET_UNIVERSE || '0'),
  startChannel: parseInt(process.env.ARTNET_START_CHANNEL || '1') - 1, // 0-indexed
  throttleMs: 33, // ~30fps max
};

// ============ STATO ============
// Track last sent color per group
const lastSent = {};
for (let i = 1; i <= NUM_GROUPS; i++) {
  lastSent[i] = '#000000';
}
let lastSendTime = 0;
let connected = false;
let artnetReceiving = false;
let packetCount = 0;
let updateCount = 0;

// RGB to hex
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// ============ DISPLAY ============
console.log('');
console.log('╔════════════════════════════════════════════════════╗');
console.log('║     🎛️  CrowdLight ArtNet Bridge - 10 Fixture     ║');
console.log('╠════════════════════════════════════════════════════╣');
console.log(`║  Server:     ${CONFIG.serverUrl.padEnd(37)}║`);
console.log(`║  Universe:   ${String(CONFIG.universe).padEnd(37)}║`);
console.log(`║  Start CH:   ${String(CONFIG.startChannel + 1).padEnd(37)}║`);
console.log(`║  Channels:   ${(CONFIG.startChannel + 1 + '-' + (CONFIG.startChannel + TOTAL_CHANNELS) + ' (' + TOTAL_CHANNELS + ' ch)').padEnd(37)}║`);
console.log('╠════════════════════════════════════════════════════╣');
console.log('║  DMX MAP:                                         ║');
for (let i = 1; i <= NUM_GROUPS; i++) {
  const start = CONFIG.startChannel + 1 + (i - 1) * 3;
  const line = `  Gruppo ${String(i).padEnd(2)} → CH ${String(start).padStart(2)}-${String(start + 2).padStart(2)} (R/G/B)`;
  console.log(`║${line.padEnd(51)}║`);
}
console.log('╚════════════════════════════════════════════════════╝');
console.log('');

// ============ SOCKET.IO CONNECTION ============
console.log('🔌 Connessione al server CrowdLight...');

const socket = io(`${CONFIG.serverUrl}/controller`, {
  auth: { password: CONFIG.password },
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionAttempts: Infinity,
  transports: ['websocket'],
});

socket.on('connect', () => {
  connected = true;
  console.log('✅ Connesso al server CrowdLight!');
  console.log('📡 In attesa di dati ArtNet sulla porta 6454...');
  console.log('');
});

socket.on('connect_error', (err) => {
  connected = false;
  if (err.message === 'Password non valida') {
    console.error('❌ PASSWORD ERRATA! Imposta CROWDLIGHT_PASS=tuapassword');
  } else {
    console.error(`❌ Errore connessione: ${err.message}`);
  }
});

socket.on('disconnect', () => {
  connected = false;
  console.log('⚠️  Disconnesso dal server. Riconnessione...');
});

socket.on('stats', (stats) => {
  const groupInfo = Object.entries(stats.groups || {})
    .map(([g, c]) => `G${g}:${c}`)
    .join(' ');
  console.log(`📊 Totale: ${stats.total} | ${groupInfo}`);
});

// ============ ARTNET RECEIVER ============
const artnetSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

artnetSocket.on('message', (msg, rinfo) => {
  // Validate ArtNet packet
  if (msg.length < 18) return;
  const header = msg.toString('ascii', 0, 7);
  if (header !== 'Art-Net') return;

  // OpCode: 0x5000 = ArtDmx (little-endian)
  const opCode = msg.readUInt16LE(8);
  if (opCode !== 0x5000) return;

  // Universe
  const subUni = msg.readUInt8(14);
  const net = msg.readUInt8(15);
  const universe = (net << 8) | subUni;
  if (universe !== CONFIG.universe) return;

  // DMX data
  const dmxLength = msg.readUInt16BE(16);
  const dmxData = msg.slice(18, 18 + dmxLength);

  if (!artnetReceiving) {
    artnetReceiving = true;
    console.log(`📡 ArtNet ricevuto da ${rinfo.address}:${rinfo.port} (Universe ${universe})`);
  }
  packetCount++;

  // Check we have enough channels
  const ch = CONFIG.startChannel;
  if (dmxData.length < ch + TOTAL_CHANNELS) return;

  // Throttle
  const now = Date.now();
  if (now - lastSendTime < CONFIG.throttleMs) return;

  // Read all 10 groups and find changes
  const updates = [];
  const logParts = [];

  for (let i = 0; i < NUM_GROUPS; i++) {
    const offset = ch + i * CHANNELS_PER_GROUP;
    const r = dmxData[offset];
    const g = dmxData[offset + 1];
    const b = dmxData[offset + 2];
    const color = rgbToHex(r, g, b);
    const groupId = i + 1;

    // Only send if changed
    if (color !== lastSent[groupId]) {
      updates.push({ group: groupId, c: color, e: 'solid', d: 100 });
      lastSent[groupId] = color;

      // Color preview for terminal
      const preview = `\x1b[48;2;${r};${g};${b}m  \x1b[0m`;
      logParts.push(`G${groupId}${preview}`);
    }
  }

  if (updates.length === 0) return;
  if (!connected) return;

  lastSendTime = now;
  updateCount++;

  // Check if all groups got the same color
  const allSame = updates.length === NUM_GROUPS &&
    updates.every(u => u.c === updates[0].c);

  if (allSame) {
    // Send single command for all
    socket.emit('color-all', { c: updates[0].c, e: 'solid', d: 100 });
  } else {
    // Send batch update
    socket.emit('color-batch', { groups: updates });
  }

  // Log
  console.log(`${logParts.join(' ')} (${updates.length} gruppi aggiornati)`);
});

artnetSocket.on('error', (err) => {
  console.error(`❌ Errore ArtNet: ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error('   La porta 6454 è già in uso. Chiudi altri software ArtNet.');
  }
});

artnetSocket.bind(CONFIG.artnetPort, CONFIG.artnetInterface, () => {
  console.log(`🎛️  ArtNet listener attivo su ${CONFIG.artnetInterface}:${CONFIG.artnetPort}`);
  console.log('');

  // Status update every 10 seconds
  setInterval(() => {
    if (artnetReceiving) {
      console.log(`📈 Pacchetti: ${packetCount} | Aggiornamenti: ${updateCount} | Server: ${connected ? '✅' : '❌'}`);
    }
  }, 10000);
});

// ============ KEYBOARD SHORTCUTS ============
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);

  console.log('⌨️  Comandi: [B]=Blackout [W]=White [R]=Rosso tutti [Q]=Esci');
  console.log('   [1-0]=Rosso singolo gruppo  [T]=Test arcobaleno');
  console.log('');

  process.stdin.on('keypress', (str, key) => {
    if (key.ctrl && key.name === 'c') process.exit();
    if (!connected) return;

    switch (key.name) {
      case 'b':
        socket.emit('blackout');
        for (let i = 1; i <= NUM_GROUPS; i++) lastSent[i] = '#000000';
        console.log('⬛ BLACKOUT');
        break;

      case 'w':
        socket.emit('color-all', { c: '#ffffff', e: 'solid', d: 100 });
        for (let i = 1; i <= NUM_GROUPS; i++) lastSent[i] = '#ffffff';
        console.log('⬜ WHITE tutti');
        break;

      case 'r':
        socket.emit('color-all', { c: '#ff0000', e: 'solid', d: 100 });
        for (let i = 1; i <= NUM_GROUPS; i++) lastSent[i] = '#ff0000';
        console.log('🔴 ROSSO tutti');
        break;

      case 't': {
        // Rainbow test: each group gets a different color
        const rainbow = [
          '#ff0000', '#ff6600', '#ffff00', '#00ff00', '#00ffff',
          '#0000ff', '#6600ff', '#ff00ff', '#ff0066', '#ffffff'
        ];
        const updates = rainbow.map((c, i) => ({ group: i + 1, c, e: 'solid', d: 100 }));
        socket.emit('color-batch', { groups: updates });
        updates.forEach(u => lastSent[u.group] = u.c);
        console.log('🌈 TEST ARCOBALENO');
        break;
      }

      case 'q':
        console.log('👋 Chiusura bridge...');
        socket.disconnect();
        artnetSocket.close();
        process.exit(0);
        break;

      default: {
        // Number keys: send red to specific group
        const numMap = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5,
                         '6': 6, '7': 7, '8': 8, '9': 9, '0': 10 };
        if (numMap[str]) {
          const g = numMap[str];
          socket.emit('color-group', { group: g, c: '#ff0000', e: 'solid', d: 100 });
          lastSent[g] = '#ff0000';
          console.log(`🔴 ROSSO → Gruppo ${g}`);
        }
      }
    }
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Chiusura bridge...');
  socket.disconnect();
  artnetSocket.close();
  process.exit(0);
});
