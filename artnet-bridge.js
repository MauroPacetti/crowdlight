#!/usr/bin/env node
/**
 * CrowdLight - ArtNet Bridge
 *
 * Questo script gira sul PC LOCALE collegato alla stessa rete del GrandMA.
 * Riceve dati ArtNet (DMX over IP) e li invia al server CrowdLight (Render).
 *
 * CANALI DMX (configurabili):
 *   CH 1 = Rosso        (0-255)
 *   CH 2 = Verde        (0-255)
 *   CH 3 = Blu          (0-255)
 *   CH 4 = Effetto      (0-63=Solid, 64-127=Fade, 128-191=Pulse, 192-255=Strobo)
 *   CH 5 = Durata       (0-255 → mappato a 50-3000ms)
 *   CH 6 = Zona         (0=Tutte, 1=Parterre, 2=Tribuna A, 3=Tribuna B,
 *                         4=Tribuna C, 5=Tribuna D, 6=Galleria, 7=VIP)
 *   CH 7 = Master/GO    (0-127=No send, 128-255=Invia comando)
 *
 * UNIVERSO: configurabile (default: 0)
 * INDIRIZZO START: configurabile (default: 1)
 *
 * USO:
 *   node artnet-bridge.js
 *
 * CONFIGURAZIONE via variabili d'ambiente o argomenti:
 *   CROWDLIGHT_URL=https://crowdlight.onrender.com
 *   CROWDLIGHT_PASS=tuapassword
 *   ARTNET_UNIVERSE=0
 *   ARTNET_START_CHANNEL=1
 *   ARTNET_INTERFACE=0.0.0.0
 */

const dgram = require('dgram');
const { io } = require('socket.io-client');
const readline = require('readline');

// ============ CONFIGURAZIONE ============
const CONFIG = {
  // Server CrowdLight
  serverUrl: process.env.CROWDLIGHT_URL || 'https://crowdlight.onrender.com',
  password: process.env.CROWDLIGHT_PASS || 'crowdlight2024',

  // ArtNet
  artnetPort: 6454,
  artnetInterface: process.env.ARTNET_INTERFACE || '0.0.0.0',
  universe: parseInt(process.env.ARTNET_UNIVERSE || '0'),
  startChannel: parseInt(process.env.ARTNET_START_CHANNEL || '1') - 1, // 0-indexed

  // Throttle: minimo ms tra un invio e l'altro (evita flood)
  throttleMs: 33, // ~30fps max

  // Auto-send: invia automaticamente quando i valori cambiano
  // Se false, usa il canale 7 (Master/GO) per inviare
  autoSend: process.env.ARTNET_AUTOSEND === 'true' || false,
};

// Zone mapping
const ZONE_MAP = {
  0: null,          // Tutte
  1: 'Parterre',
  2: 'Tribuna A',
  3: 'Tribuna B',
  4: 'Tribuna C',
  5: 'Tribuna D',
  6: 'Galleria',
  7: 'VIP',
};

// Effect mapping
function getEffect(value) {
  if (value < 64) return 'solid';
  if (value < 128) return 'fade';
  if (value < 192) return 'pulse';
  return 'strobe';
}

// Duration mapping: 0-255 → 50-3000ms
function getDuration(value) {
  return Math.round(50 + (value / 255) * 2950);
}

// RGB to hex
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// ============ STATO ============
let lastSent = { c: '', e: '', d: 0, zone: null };
let lastSendTime = 0;
let connected = false;
let artnetReceiving = false;
let packetCount = 0;

// ============ SOCKET.IO CONNECTION ============
console.log('');
console.log('╔══════════════════════════════════════════════╗');
console.log('║       🎛️  CrowdLight ArtNet Bridge  🎛️       ║');
console.log('╠══════════════════════════════════════════════╣');
console.log(`║  Server:   ${CONFIG.serverUrl.padEnd(33)}║`);
console.log(`║  Universe: ${String(CONFIG.universe).padEnd(33)}║`);
console.log(`║  Start CH: ${String(CONFIG.startChannel + 1).padEnd(33)}║`);
console.log(`║  AutoSend: ${String(CONFIG.autoSend).padEnd(33)}║`);
console.log('╚══════════════════════════════════════════════╝');
console.log('');

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
  console.log(`📊 Telefoni connessi: ${stats.total} | Zone: ${JSON.stringify(stats.zones)}`);
});

// ============ ARTNET RECEIVER ============
const artnetSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

artnetSocket.on('message', (msg, rinfo) => {
  // Validate ArtNet packet
  // Header: "Art-Net\0" (8 bytes)
  if (msg.length < 18) return;
  const header = msg.toString('ascii', 0, 7);
  if (header !== 'Art-Net') return;

  // OpCode: 0x5000 = ArtDmx (little-endian)
  const opCode = msg.readUInt16LE(8);
  if (opCode !== 0x5000) return;

  // Universe (bytes 14-15, little-endian in ArtNet v4)
  // Subnet (high nibble of byte 14) + Universe (low nibble of byte 14)
  const subUni = msg.readUInt8(14);
  const net = msg.readUInt8(15);
  const universe = (net << 8) | subUni;

  if (universe !== CONFIG.universe) return;

  // DMX data length
  const dmxLength = msg.readUInt16BE(16);
  const dmxData = msg.slice(18, 18 + dmxLength);

  if (!artnetReceiving) {
    artnetReceiving = true;
    console.log(`📡 ArtNet ricevuto da ${rinfo.address}:${rinfo.port} (Universe ${universe})`);
  }
  packetCount++;

  // Extract channels
  const ch = CONFIG.startChannel;
  if (dmxData.length < ch + 7) return;

  const r = dmxData[ch];
  const g = dmxData[ch + 1];
  const b = dmxData[ch + 2];
  const effectVal = dmxData[ch + 3];
  const durationVal = dmxData[ch + 4];
  const zoneVal = dmxData[ch + 5];
  const masterGo = dmxData[ch + 6];

  const color = rgbToHex(r, g, b);
  const effect = getEffect(effectVal);
  const duration = getDuration(durationVal);
  const zoneIndex = Math.min(Math.floor(zoneVal / 32), 7); // 0-7
  const zone = ZONE_MAP[zoneIndex] || null;

  // Check if should send
  const shouldSend = CONFIG.autoSend || masterGo >= 128;
  if (!shouldSend) return;

  // Throttle
  const now = Date.now();
  if (now - lastSendTime < CONFIG.throttleMs) return;

  // Check if values actually changed
  const newState = { c: color, e: effect, d: duration, zone: zone };
  if (newState.c === lastSent.c && newState.e === lastSent.e &&
      newState.d === lastSent.d && newState.zone === lastSent.zone) return;

  // Send!
  if (connected) {
    const data = { c: color, e: effect, d: duration };

    if (zone) {
      data.zone = zone;
      socket.emit('color-zone', data);
    } else {
      socket.emit('color-all', data);
    }

    lastSent = newState;
    lastSendTime = now;

    // Log con colore
    const preview = `\x1b[48;2;${r};${g};${b}m   \x1b[0m`;
    console.log(`${preview} → ${color} | ${effect} | ${duration}ms | Zone: ${zone || 'TUTTE'}`);
  }
});

artnetSocket.on('error', (err) => {
  console.error(`❌ Errore ArtNet: ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error('   La porta 6454 è già in uso. Chiudi altri software ArtNet.');
  }
});

artnetSocket.bind(CONFIG.artnetPort, CONFIG.artnetInterface, () => {
  console.log(`🎛️  ArtNet listener attivo su ${CONFIG.artnetInterface}:${CONFIG.artnetPort}`);
  console.log(`   Universe: ${CONFIG.universe}, Start Channel: ${CONFIG.startChannel + 1}`);
  console.log('');

  // Status update every 10 seconds
  setInterval(() => {
    if (artnetReceiving) {
      console.log(`📈 Pacchetti ArtNet ricevuti: ${packetCount} | Server: ${connected ? '✅' : '❌'}`);
    }
  }, 10000);
});

// ============ KEYBOARD SHORTCUTS ============
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);

  console.log('⌨️  Comandi: [B]=Blackout [W]=White [Q]=Esci [A]=Toggle AutoSend');
  console.log('');

  process.stdin.on('keypress', (str, key) => {
    if (key.ctrl && key.name === 'c') {
      process.exit();
    }

    if (!connected) return;

    switch (key.name) {
      case 'b':
        socket.emit('blackout');
        console.log('⬛ BLACKOUT inviato');
        break;
      case 'w':
        socket.emit('color-all', { c: '#ffffff', e: 'solid', d: 500 });
        console.log('⬜ WHITE inviato');
        break;
      case 'a':
        CONFIG.autoSend = !CONFIG.autoSend;
        console.log(`🔄 AutoSend: ${CONFIG.autoSend ? 'ON' : 'OFF'}`);
        break;
      case 'q':
        console.log('👋 Chiusura bridge...');
        socket.disconnect();
        artnetSocket.close();
        process.exit(0);
        break;
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
