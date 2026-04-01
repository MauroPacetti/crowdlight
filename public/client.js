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

  function showStatus(msg, dur) {
    status.textContent = msg;
    status.classList.add('visible');
    if (dur) {
      setTimeout(() => status.classList.remove('visible'), dur);
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
      setTimeout(() => groupBadge.classList.remove('visible'), 5000);
    }
  });

  // --- Effect engine (pure JavaScript, no CSS animations) ---
  let effectTimer = null;
  let currentColor = '#000000';

  function stopEffect() {
    if (effectTimer) {
      clearInterval(effectTimer);
      effectTimer = null;
    }
    body.style.opacity = '1';
  }

  function applyColor(color) {
    body.style.backgroundColor = color;
  }

  function startStrobe(color, duration) {
    applyColor(color);
    const blinkTime = Math.max(30, duration / 5);
    let on = true;
    effectTimer = setInterval(() => {
      on = !on;
      body.style.backgroundColor = on ? color : '#000000';
    }, blinkTime);
  }

  function startPulse(color, duration) {
    applyColor(color);
    const stepTime = 20; // 20ms per frame (~50fps)
    const totalSteps = Math.max(2, Math.round(duration / stepTime));
    let step = 0;
    let goingDown = true;
    effectTimer = setInterval(() => {
      const progress = step / totalSteps;
      // Sine wave for smooth pulse: opacity goes 1 -> 0.15 -> 1
      const opacity = 0.15 + 0.85 * (0.5 + 0.5 * Math.cos(progress * 2 * Math.PI));
      body.style.opacity = opacity.toFixed(3);
      step = (step + 1) % totalSteps;
    }, stepTime);
  }

  // --- Color handling ---
  socket.on('color', (data) => {
    if (!data || !data.c) return;

    const color = data.c;
    const effect = data.e || 'solid';
    const duration = data.d || 500;

    // Stop any running effect
    stopEffect();

    // Reset transition
    body.style.transition = 'none';

    switch (effect) {
      case 'solid':
        applyColor(color);
        break;
      case 'fade':
        body.style.transition = 'background-color ' + duration + 'ms ease';
        void body.offsetHeight;
        applyColor(color);
        break;
      case 'pulse':
        startPulse(color, duration);
        break;
      case 'strobe':
        startStrobe(color, duration);
        break;
      default:
        applyColor(color);
    }

    currentColor = color;

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
