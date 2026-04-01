// CrowdLight Event Client - connects to a specific event by slug
(function () {
  // Extract slug from URL: /event/{slug}
  const parts = window.location.pathname.split('/');
  const slugIdx = parts.indexOf('event');
  const slug = slugIdx >= 0 ? parts[slugIdx + 1] : null;
  if (!slug) { document.getElementById('consentError').textContent = 'URL non valido'; document.getElementById('consentError').style.display = 'block'; return; }

  const consent = document.getElementById('consent');
  const eventNameEl = document.getElementById('eventName');
  const enterBtn = document.getElementById('enterBtn');
  const consentError = document.getElementById('consentError');
  const status = document.getElementById('status');
  const groupBadge = document.getElementById('groupBadge');
  const body = document.body;

  // Load event info
  fetch(`/api/events/${slug}`).then(r => r.json()).then(data => {
    if (data.error) {
      eventNameEl.textContent = '';
      consentError.textContent = data.error;
      consentError.style.display = 'block';
      return;
    }
    eventNameEl.textContent = data.event.name;
    enterBtn.style.display = '';
    // Show event logo if available
    if (data.event.logo) {
      const logoEl = document.getElementById('eventLogo');
      logoEl.src = data.event.logo;
      logoEl.style.display = '';
    }
    if (!data.event.is_active) {
      enterBtn.style.display = 'none';
      consentError.textContent = 'Evento non attivo';
      consentError.style.display = 'block';
    }
  }).catch(() => {
    consentError.textContent = 'Errore di connessione';
    consentError.style.display = 'block';
  });

  enterBtn.addEventListener('click', () => {
    consent.classList.add('hidden');
    startConnection();
  });

  function startConnection() {
    // Wake Lock
    let wakeLock = null;
    async function requestWakeLock() {
      try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) {}
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock(); });
    requestWakeLock();

    // Fullscreen
    function goFullscreen() {
      const el = document.documentElement;
      const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
      if (rfs) rfs.call(el).catch(() => {});
    }
    body.addEventListener('click', goFullscreen, { once: false });
    body.addEventListener('touchstart', goFullscreen, { once: false });

    // Socket connection with slug
    const socket = io('/audience', {
      auth: { slug },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      transports: ['websocket', 'polling'],
    });

    function showStatus(msg, dur) {
      status.textContent = msg;
      status.classList.add('visible');
      if (dur) setTimeout(() => status.classList.remove('visible'), dur);
    }

    socket.on('connect', () => {
      showStatus('Connesso!', 2000);
      setTimeout(() => showStatus('Alza la luminosita al massimo!', 3000), 2500);
    });
    socket.on('disconnect', () => showStatus('Riconnessione...'));
    socket.on('reconnect', () => showStatus('Riconnesso!', 2000));

    socket.on('assigned', (data) => {
      if (groupBadge) {
        groupBadge.textContent = 'G' + data.group;
        groupBadge.classList.add('visible');
        setTimeout(() => groupBadge.classList.remove('visible'), 5000);
      }
    });

    // Effect engine (pure JavaScript)
    let effectTimer = null;
    function stopEffect() {
      if (effectTimer) { clearInterval(effectTimer); effectTimer = null; }
      body.style.opacity = '1';
    }

    socket.on('color', (data) => {
      if (!data || !data.c) return;
      const color = data.c;
      const effect = data.e || 'solid';
      const duration = data.d || 500;

      stopEffect();
      body.style.transition = 'none';

      switch (effect) {
        case 'solid':
          body.style.backgroundColor = color;
          break;
        case 'fade':
          body.style.transition = 'background-color ' + duration + 'ms ease';
          void body.offsetHeight;
          body.style.backgroundColor = color;
          break;
        case 'pulse':
          body.style.backgroundColor = color;
          const stepTime = 20;
          const totalSteps = Math.max(2, Math.round(duration / stepTime));
          let step = 0;
          effectTimer = setInterval(() => {
            const opacity = 0.15 + 0.85 * (0.5 + 0.5 * Math.cos((step / totalSteps) * 2 * Math.PI));
            body.style.opacity = opacity.toFixed(3);
            step = (step + 1) % totalSteps;
          }, stepTime);
          break;
        case 'strobe':
          body.style.backgroundColor = color;
          const blinkTime = Math.max(30, duration / 5);
          let on = true;
          effectTimer = setInterval(() => {
            on = !on;
            body.style.backgroundColor = on ? color : '#000000';
          }, blinkTime);
          break;
        default:
          body.style.backgroundColor = color;
      }

      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', color);
    });

    // Prevent scrolling
    document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }
})();
