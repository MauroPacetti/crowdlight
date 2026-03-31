// CrowdLight Client - Riceve comandi colore dal server
(function () {
  const status = document.getElementById('status');
  const tapHint = document.getElementById('tapHint');
  const groupBadge = document.getElementById('groupBadge');
  const body = document.body;

  let myGroup = null;

  // --- Wake Lock ---
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* silently fail */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
  });
  requestWakeLock();

  // --- Fullscreen ---
  function goFullscreen() {
    const el = document.documentElement;
    const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (rfs) {
      rfs.call(el).catch(() => {});
      tapHint.classList.add('hidden');
    }
  }
  body.addEventListener('click', goFullscreen, { once: false });
  body.addEventListener('touchstart', goFullscreen, { once: false });

  // --- Max brightness hint ---
  function showBrightnessHint() {
    if (status) {
      status.textContent = 'Alza la luminosità al massimo!';
      status.classList.add('visible');
      setTimeout(() => status.classList.remove('visible'), 3000);
    }
  }

  // --- Socket.io connection ---
  const socket = io('/audience', {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
    transports: ['websocket', 'polling'],
  });

  function showStatus(msg, duration) {
    status.textContent = msg;
    status.classList.add('visible');
    if (duration) {
      setTimeout(() => status.classList.remove('visible'), duration);
    }
  }

  socket.on('connect', () => {
    showStatus('Connesso!', 2000);
    setTimeout(showBrightnessHint, 2500);
  });

  socket.on('disconnect', () => {
    showStatus('Riconnessione...');
  });

  socket.on('reconnect', () => {
    showStatus('Riconnesso!', 2000);
  });

  // --- Group assignment ---
  socket.on('assigned', (data) => {
    myGroup = data.group;
    if (groupBadge) {
      groupBadge.textContent = 'G' + data.group;
      groupBadge.classList.add('visible');
      // Hide after 5 seconds
      setTimeout(() => groupBadge.classList.remove('visible'), 5000);
    }
  });

  // --- Color handling ---
  let currentEffect = '';

  socket.on('color', (data) => {
    if (!data || !data.c) return;

    const color = data.c;
    const effect = data.e || 'solid';
    const duration = data.d || 500;

    // Remove old effect classes
    body.classList.remove('effect-solid', 'effect-fade', 'effect-pulse', 'effect-strobe');

    // Set CSS custom properties for animation durations
    body.style.setProperty('--pulse-duration', duration + 'ms');
    body.style.setProperty('--strobe-duration', Math.max(50, duration / 5) + 'ms');

    // Apply effect
    switch (effect) {
      case 'solid':
        body.classList.add('effect-solid');
        body.style.backgroundColor = color;
        break;
      case 'fade':
        body.style.transition = 'background-color ' + duration + 'ms ease';
        body.classList.add('effect-fade');
        void body.offsetHeight;
        body.style.backgroundColor = color;
        break;
      case 'pulse':
        body.style.backgroundColor = color;
        body.classList.add('effect-pulse');
        break;
      case 'strobe':
        body.style.backgroundColor = color;
        body.classList.add('effect-strobe');
        break;
      default:
        body.classList.add('effect-solid');
        body.style.backgroundColor = color;
    }

    currentEffect = effect;

    // Update theme-color meta
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', color);
  });

  // Hide tap hint after first color received
  socket.on('color', () => {
    tapHint.classList.add('hidden');
  });

  // Prevent scrolling / pull-to-refresh
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
