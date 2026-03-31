// CrowdLight Controller - Dashboard per l'organizzatore
(function () {
  // --- Config ---
  const PRESETS = [
    { name: 'Rosso', c: '#ff0000' },
    { name: 'Blu', c: '#0000ff' },
    { name: 'Verde', c: '#00ff00' },
    { name: 'Giallo', c: '#ffff00' },
    { name: 'Viola', c: '#9b59b6' },
    { name: 'Ciano', c: '#00ffff' },
    { name: 'Arancione', c: '#ff6600' },
    { name: 'Rosa', c: '#ff69b4' },
    { name: 'Bianco', c: '#ffffff' },
    { name: 'Oro', c: '#ffd700' },
  ];
  const EFFECTS = [
    { id: 'solid', label: 'Solido' },
    { id: 'fade', label: 'Fade' },
    { id: 'pulse', label: 'Pulse' },
    { id: 'strobe', label: 'Strobo' },
  ];

  // --- DOM refs ---
  const loginOverlay = document.getElementById('loginOverlay');
  const loginPass = document.getElementById('loginPass');
  const loginBtn = document.getElementById('loginBtn');
  const loginError = document.getElementById('loginError');
  const connDot = document.getElementById('connDot');
  const totalCount = document.getElementById('totalCount');
  const colorPicker = document.getElementById('colorPicker');
  const colorHex = document.getElementById('colorHex');
  const presetsEl = document.getElementById('presets');
  const effectsRow = document.getElementById('effectsRow');
  const duration = document.getElementById('duration');
  const durationVal = document.getElementById('durationVal');
  const zoneTarget = document.getElementById('zoneTarget');
  const zoneList = document.getElementById('zoneList');
  const previewBox = document.getElementById('previewBox');
  const goBtn = document.getElementById('goBtn');
  const blackoutBtn = document.getElementById('blackoutBtn');
  const whiteBtn = document.getElementById('whiteBtn');
  const seqSteps = document.getElementById('seqSteps');
  const addStepBtn = document.getElementById('addStepBtn');
  const playSeqBtn = document.getElementById('playSeqBtn');
  const clearSeqBtn = document.getElementById('clearSeqBtn');

  let socket = null;
  let currentColor = '#ff0000';
  let currentEffect = 'solid';
  let sequence = [];

  // --- Login ---
  function doLogin() {
    const pass = loginPass.value.trim();
    if (!pass) return;

    socket = io('/controller', {
      auth: { password: pass },
      reconnection: true,
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      loginOverlay.classList.add('hidden');
      connDot.classList.add('connected');
      setupSocketListeners();
    });

    socket.on('connect_error', (err) => {
      loginError.style.display = 'block';
      loginError.textContent = err.message || 'Errore di connessione';
      socket.disconnect();
      socket = null;
    });

    socket.on('disconnect', () => {
      connDot.classList.remove('connected');
    });
  }

  loginBtn.addEventListener('click', doLogin);
  loginPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  // --- Socket listeners ---
  function setupSocketListeners() {
    socket.on('stats', (data) => {
      totalCount.textContent = data.total || 0;
      updateZoneList(data.zones || {});
      updateZoneSelect(data.zones || {});
    });

    socket.on('current-state', (data) => {
      if (data.global) {
        currentColor = data.global.c || '#000000';
        currentEffect = data.global.e || 'solid';
        colorPicker.value = currentColor;
        colorHex.textContent = currentColor.toUpperCase();
        previewBox.style.backgroundColor = currentColor;
        updateEffectButtons();
        if (data.global.d) {
          duration.value = data.global.d;
          durationVal.textContent = data.global.d + 'ms';
        }
      }
    });
  }

  // --- Zone list ---
  function updateZoneList(zones) {
    const entries = Object.entries(zones).filter(([, count]) => count > 0);
    if (entries.length === 0) {
      zoneList.innerHTML = '<li class="zone-item"><span style="color:#666">Nessuna zona attiva</span></li>';
      return;
    }
    zoneList.innerHTML = entries
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `
        <li class="zone-item">
          <span>${name}</span>
          <span class="zone-count">${count}</span>
        </li>
      `).join('');
  }

  function updateZoneSelect(zones) {
    const current = zoneTarget.value;
    const entries = Object.entries(zones).filter(([, count]) => count > 0);
    zoneTarget.innerHTML = '<option value="">Tutti i telefoni</option>';
    entries.sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, count]) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = `${name} (${count})`;
      zoneTarget.appendChild(opt);
    });
    if (current) zoneTarget.value = current;
  }

  // --- Presets ---
  PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.style.background = p.c;
    btn.title = p.name;
    btn.addEventListener('click', () => {
      setColor(p.c);
    });
    presetsEl.appendChild(btn);
  });

  function setColor(c) {
    currentColor = c;
    colorPicker.value = c;
    colorHex.textContent = c.toUpperCase();
    previewBox.style.backgroundColor = c;
    // Update preset active state
    document.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.style.background === c || rgbToHex(btn.style.background) === c.toLowerCase());
    });
  }

  colorPicker.addEventListener('input', (e) => {
    setColor(e.target.value);
  });

  // --- Effects ---
  EFFECTS.forEach((ef) => {
    const btn = document.createElement('button');
    btn.className = 'effect-btn' + (ef.id === currentEffect ? ' active' : '');
    btn.textContent = ef.label;
    btn.dataset.effect = ef.id;
    btn.addEventListener('click', () => {
      currentEffect = ef.id;
      updateEffectButtons();
    });
    effectsRow.appendChild(btn);
  });

  function updateEffectButtons() {
    document.querySelectorAll('.effect-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.effect === currentEffect);
    });
  }

  // --- Duration ---
  duration.addEventListener('input', () => {
    durationVal.textContent = duration.value + 'ms';
  });

  // --- GO button ---
  goBtn.addEventListener('click', () => {
    if (!socket || !socket.connected) return;
    const data = {
      c: currentColor,
      e: currentEffect,
      d: parseInt(duration.value),
    };
    const zone = zoneTarget.value;
    if (zone) {
      socket.emit('color-zone', { ...data, zone });
    } else {
      socket.emit('color-all', data);
    }
  });

  // --- Blackout ---
  blackoutBtn.addEventListener('click', () => {
    if (!socket || !socket.connected) return;
    socket.emit('blackout');
    setColor('#000000');
  });

  // --- White ---
  whiteBtn.addEventListener('click', () => {
    if (!socket || !socket.connected) return;
    setColor('#ffffff');
    const data = { c: '#ffffff', e: 'solid', d: 0 };
    const zone = zoneTarget.value;
    if (zone) {
      socket.emit('color-zone', { ...data, zone });
    } else {
      socket.emit('color-all', data);
    }
  });

  // --- Sequence Builder ---
  function renderSequence() {
    seqSteps.innerHTML = '';
    sequence.forEach((step, i) => {
      const div = document.createElement('div');
      div.className = 'seq-step';
      div.innerHTML = `
        <div class="swatch" style="background:${step.c}"></div>
        <span>${step.e}</span>
        <label>Attesa:</label>
        <input type="number" value="${step.wait}" min="100" step="100" data-idx="${i}" class="seq-wait-input">
        <span>ms</span>
        <button class="remove-step" data-idx="${i}">&times;</button>
      `;
      seqSteps.appendChild(div);
    });
    // Bind events
    document.querySelectorAll('.seq-wait-input').forEach((inp) => {
      inp.addEventListener('change', (e) => {
        sequence[parseInt(e.target.dataset.idx)].wait = parseInt(e.target.value) || 1000;
      });
    });
    document.querySelectorAll('.remove-step').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        sequence.splice(parseInt(e.target.dataset.idx), 1);
        renderSequence();
      });
    });
  }

  addStepBtn.addEventListener('click', () => {
    sequence.push({
      c: currentColor,
      e: currentEffect,
      d: parseInt(duration.value),
      wait: 1000,
      zone: zoneTarget.value || null,
    });
    renderSequence();
  });

  clearSeqBtn.addEventListener('click', () => {
    sequence = [];
    renderSequence();
  });

  playSeqBtn.addEventListener('click', () => {
    if (!socket || !socket.connected || sequence.length === 0) return;
    socket.emit('sequence', { steps: sequence });

    // Local preview
    let delay = 0;
    sequence.forEach((step) => {
      setTimeout(() => {
        previewBox.style.backgroundColor = step.c;
      }, delay);
      delay += step.wait;
    });
  });

  // --- Utility ---
  function rgbToHex(rgb) {
    if (!rgb || rgb.startsWith('#')) return rgb;
    const m = rgb.match(/\d+/g);
    if (!m || m.length < 3) return rgb;
    return '#' + m.slice(0, 3).map((x) => parseInt(x).toString(16).padStart(2, '0')).join('');
  }

  // Keyboard shortcut: Space = GO, B = Blackout, W = White
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); goBtn.click(); }
    if (e.code === 'KeyB') blackoutBtn.click();
    if (e.code === 'KeyW') whiteBtn.click();
  });
})();
