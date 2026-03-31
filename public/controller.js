// CrowdLight Controller - 10 Groups as DMX fixtures
(function () {
  const NUM_GROUPS = 10;

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
  const groupsGrid = document.getElementById('groupsGrid');
  const groupList = document.getElementById('groupList');
  const dmxMap = document.getElementById('dmxMap');
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
  let selectedGroups = new Set();
  let groupCounts = {};
  let groupColors = {}; // Track current color per group

  // Init: select all groups
  for (let i = 1; i <= NUM_GROUPS; i++) {
    selectedGroups.add(i);
    groupColors[i] = '#000000';
  }

  // --- Build Groups Grid ---
  function buildGroupsGrid() {
    groupsGrid.innerHTML = '';
    for (let i = 1; i <= NUM_GROUPS; i++) {
      const card = document.createElement('div');
      card.className = 'group-card' + (selectedGroups.has(i) ? ' selected' : '');
      card.dataset.group = i;
      card.innerHTML = `
        <div class="g-num">Gruppo ${i}</div>
        <div class="g-preview" id="gPreview${i}"></div>
        <div class="g-count" id="gCount${i}">0 tel</div>
        <div class="g-color-label" id="gColorLabel${i}">#000000</div>
      `;
      card.addEventListener('click', (e) => {
        e.preventDefault();
        if (selectedGroups.has(i)) {
          selectedGroups.delete(i);
          card.classList.remove('selected');
        } else {
          selectedGroups.add(i);
          card.classList.add('selected');
        }
        updateSelectionButtons();
      });
      groupsGrid.appendChild(card);
    }
  }
  buildGroupsGrid();

  // --- Selection bar ---
  document.querySelectorAll('.sel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sel = btn.dataset.sel;
      selectedGroups.clear();
      if (sel === 'all') {
        for (let i = 1; i <= NUM_GROUPS; i++) selectedGroups.add(i);
      } else if (sel === 'odd') {
        for (let i = 1; i <= NUM_GROUPS; i += 2) selectedGroups.add(i);
      } else if (sel === 'even') {
        for (let i = 2; i <= NUM_GROUPS; i += 2) selectedGroups.add(i);
      }
      // Update cards
      document.querySelectorAll('.group-card').forEach((card) => {
        const g = parseInt(card.dataset.group);
        card.classList.toggle('selected', selectedGroups.has(g));
      });
      updateSelectionButtons();
    });
  });

  function updateSelectionButtons() {
    document.querySelectorAll('.sel-btn').forEach((btn) => {
      const sel = btn.dataset.sel;
      let match = false;
      if (sel === 'all' && selectedGroups.size === NUM_GROUPS) match = true;
      if (sel === 'none' && selectedGroups.size === 0) match = true;
      if (sel === 'odd') {
        const odd = new Set(); for (let i = 1; i <= NUM_GROUPS; i += 2) odd.add(i);
        match = selectedGroups.size === odd.size && [...selectedGroups].every(g => odd.has(g));
      }
      if (sel === 'even') {
        const even = new Set(); for (let i = 2; i <= NUM_GROUPS; i += 2) even.add(i);
        match = selectedGroups.size === even.size && [...selectedGroups].every(g => even.has(g));
      }
      btn.classList.toggle('active', match);
    });
  }

  // --- DMX Map ---
  function buildDmxMap() {
    let html = '<table>';
    for (let i = 1; i <= NUM_GROUPS; i++) {
      const start = (i - 1) * 3 + 1;
      html += `<tr>
        <td>Gruppo ${i}</td>
        <td>CH ${start}-${start + 2}</td>
        <td>R/G/B</td>
      </tr>`;
    }
    html += '</table>';
    dmxMap.innerHTML = html;
  }
  buildDmxMap();

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
      groupCounts = data.groups || {};
      updateGroupCounts();
    });

    socket.on('current-state', (data) => {
      if (data.groups) {
        for (const [g, state] of Object.entries(data.groups)) {
          groupColors[g] = state.c || '#000000';
          updateGroupPreview(parseInt(g), state);
        }
      }
    });

    socket.on('group-update', (data) => {
      if (data.group === 'all') {
        for (let i = 1; i <= NUM_GROUPS; i++) {
          groupColors[i] = data.state.c;
          updateGroupPreview(i, data.state);
        }
      } else {
        groupColors[data.group] = data.state.c;
        updateGroupPreview(data.group, data.state);
      }
    });

    socket.on('state-sync', (allStates) => {
      for (const [g, state] of Object.entries(allStates)) {
        groupColors[g] = state.c || '#000000';
        updateGroupPreview(parseInt(g), state);
      }
    });
  }

  function updateGroupCounts() {
    for (let i = 1; i <= NUM_GROUPS; i++) {
      const el = document.getElementById(`gCount${i}`);
      if (el) el.textContent = (groupCounts[i] || 0) + ' tel';
    }
    // Update sidebar list
    let html = '';
    let total = 0;
    for (let i = 1; i <= NUM_GROUPS; i++) {
      const count = groupCounts[i] || 0;
      total += count;
      const color = groupColors[i] || '#000000';
      html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #1a1a1a;font-size:0.8rem;">
        <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${color};margin-right:6px;vertical-align:middle;border:1px solid #333;"></span>Gruppo ${i}</span>
        <span style="color:#4ecdc4;font-weight:600;">${count}</span>
      </div>`;
    }
    groupList.innerHTML = html;
  }

  function updateGroupPreview(groupId, state) {
    const preview = document.getElementById(`gPreview${groupId}`);
    const label = document.getElementById(`gColorLabel${groupId}`);
    if (preview) preview.style.background = state.c;
    if (label) label.textContent = state.c.toUpperCase();
  }

  // --- Presets ---
  PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.style.background = p.c;
    btn.title = p.name;
    btn.addEventListener('click', () => setColor(p.c));
    presetsEl.appendChild(btn);
  });

  function setColor(c) {
    currentColor = c;
    colorPicker.value = c;
    colorHex.textContent = c.toUpperCase();
    document.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.classList.toggle('active', rgbToHex(btn.style.background) === c.toLowerCase());
    });
  }

  colorPicker.addEventListener('input', (e) => setColor(e.target.value));

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

  // --- GO: send to selected groups ---
  goBtn.addEventListener('click', () => {
    if (!socket || !socket.connected) return;
    const data = { c: currentColor, e: currentEffect, d: parseInt(duration.value) };

    if (selectedGroups.size === NUM_GROUPS) {
      // All groups
      socket.emit('color-all', data);
    } else if (selectedGroups.size > 0) {
      // Batch update selected groups
      const updates = [...selectedGroups].map(g => ({ group: g, ...data }));
      socket.emit('color-batch', { groups: updates });
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
    if (selectedGroups.size === NUM_GROUPS) {
      socket.emit('color-all', data);
    } else {
      const updates = [...selectedGroups].map(g => ({ group: g, ...data }));
      socket.emit('color-batch', { groups: updates });
    }
  });

  // --- Sequence Builder ---
  function renderSequence() {
    seqSteps.innerHTML = '';
    sequence.forEach((step, i) => {
      const div = document.createElement('div');
      div.className = 'seq-step';
      const groupsLabel = step.groups.length === NUM_GROUPS ? 'TUTTI' : step.groups.map(g => 'G' + g).join(',');
      div.innerHTML = `
        <div class="swatch" style="background:${step.c}"></div>
        <span style="font-size:0.65rem;color:#888">${groupsLabel}</span>
        <span>${step.e}</span>
        <label>ms:</label>
        <input type="number" value="${step.wait}" min="100" step="100" data-idx="${i}" class="seq-wait-input">
        <button class="remove-step" data-idx="${i}">&times;</button>
      `;
      seqSteps.appendChild(div);
    });
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
      groups: [...selectedGroups],
    });
    renderSequence();
  });

  clearSeqBtn.addEventListener('click', () => { sequence = []; renderSequence(); });

  playSeqBtn.addEventListener('click', () => {
    if (!socket || !socket.connected || sequence.length === 0) return;
    // Convert to server format
    const steps = sequence.map(s => ({
      c: s.c, e: s.e, d: s.d, wait: s.wait,
      group: s.groups.length === NUM_GROUPS ? 0 : s.groups[0], // simplified
    }));
    socket.emit('sequence', { steps });
  });

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); goBtn.click(); }
    if (e.code === 'KeyB') blackoutBtn.click();
    if (e.code === 'KeyW') whiteBtn.click();
    // Number keys 1-0 toggle group selection
    const numMap = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5,
                     Digit6: 6, Digit7: 7, Digit8: 8, Digit9: 9, Digit0: 10 };
    if (numMap[e.code]) {
      const g = numMap[e.code];
      const card = document.querySelector(`.group-card[data-group="${g}"]`);
      if (card) card.click();
    }
    // A = select all
    if (e.code === 'KeyA') {
      document.querySelector('.sel-btn[data-sel="all"]').click();
    }
  });

  // --- Utility ---
  function rgbToHex(rgb) {
    if (!rgb || rgb.startsWith('#')) return rgb;
    const m = rgb.match(/\d+/g);
    if (!m || m.length < 3) return rgb;
    return '#' + m.slice(0, 3).map((x) => parseInt(x).toString(16).padStart(2, '0')).join('');
  }
})();
