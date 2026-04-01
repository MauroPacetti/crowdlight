(function () {
  const token = localStorage.getItem('token');
  if (!token) { window.location.href = '/'; return; }

  const user = JSON.parse(localStorage.getItem('user') || '{}');
  document.getElementById('userName').textContent = user.name || user.email || '';

  const eventsList = document.getElementById('eventsList');
  const newEventModal = document.getElementById('newEventModal');
  const qrModal = document.getElementById('qrModal');

  async function api(url, method, body) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (res.status === 401) { localStorage.clear(); window.location.href = '/'; return; }
    return res.json();
  }

  async function loadEvents() {
    const data = await api('/api/events', 'GET');
    if (!data || !data.events) return;
    if (data.events.length === 0) {
      eventsList.innerHTML = '<div class="empty">Nessun evento. Crea il tuo primo evento!</div>';
      return;
    }
    eventsList.innerHTML = data.events.map(ev => `
      <div class="event-card" data-slug="${ev.slug}">
        <div class="ev-info">
          <h3>${escapeHtml(ev.name)}</h3>
          <div class="ev-meta">
            <span class="badge ${ev.is_active ? 'badge-active' : 'badge-inactive'}">${ev.is_active ? 'ATTIVO' : 'INATTIVO'}</span>
            <span>${ev.num_groups} gruppi</span>
            <span>${ev.stats?.total || 0} connessi</span>
            <span>slug: ${ev.slug}</span>
          </div>
        </div>
        <div class="ev-actions">
          <a href="/event/${ev.slug}/control" class="btn-sm primary" onclick="localStorage.setItem('ctrl_token_${ev.slug}','${ev.controller_token}')">Controller</a>
          <button class="btn-sm" onclick="showQR('${ev.slug}')">QR Code</button>
          <button class="btn-sm" onclick="copyLink('${ev.slug}')">Copia Link</button>
          <button class="btn-sm danger" onclick="deleteEvent('${ev.slug}')">Elimina</button>
        </div>
      </div>
    `).join('');
  }

  // New event
  document.getElementById('newEventBtn').addEventListener('click', () => newEventModal.classList.add('open'));
  document.getElementById('cancelNewEvent').addEventListener('click', () => newEventModal.classList.remove('open'));
  newEventModal.addEventListener('click', (e) => { if (e.target === newEventModal) newEventModal.classList.remove('open'); });

  document.getElementById('createEventBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('newEventError');
    errEl.style.display = 'none';
    const name = document.getElementById('newEventName').value.trim();
    if (!name) { errEl.textContent = 'Nome richiesto'; errEl.style.display = 'block'; return; }

    const data = await api('/api/events', 'POST', {
      name,
      numGroups: parseInt(document.getElementById('newEventGroups').value) || 10,
      maxAudience: parseInt(document.getElementById('newEventAudience').value) || 500,
    });
    if (data.error) { errEl.textContent = data.error; errEl.style.display = 'block'; return; }
    newEventModal.classList.remove('open');
    document.getElementById('newEventName').value = '';
    loadEvents();
  });

  // QR Code
  window.showQR = async function (slug) {
    const data = await api(`/api/events/${slug}/qr`, 'GET');
    if (!data || data.error) return;
    document.getElementById('qrImage').src = data.qr;
    document.getElementById('qrUrl').textContent = data.url;
    qrModal.classList.add('open');
  };
  document.getElementById('closeQrModal').addEventListener('click', () => qrModal.classList.remove('open'));
  qrModal.addEventListener('click', (e) => { if (e.target === qrModal) qrModal.classList.remove('open'); });

  // Copy link
  window.copyLink = function (slug) {
    const url = `${window.location.origin}/event/${slug}`;
    navigator.clipboard.writeText(url).then(() => alert('Link copiato!')).catch(() => {});
  };

  // Delete event
  window.deleteEvent = async function (slug) {
    if (!confirm('Sei sicuro di voler eliminare questo evento?')) return;
    await api(`/api/events/${slug}`, 'DELETE');
    loadEvents();
  };

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.clear();
    window.location.href = '/';
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Tunnel ---
  const tunnelDot = document.getElementById('tunnelDot');
  const tunnelUrlEl = document.getElementById('tunnelUrl');
  const tunnelBtn = document.getElementById('tunnelBtn');
  const tunnelQr = document.getElementById('tunnelQr');

  async function checkTunnelStatus() {
    try {
      const data = await api('/api/tunnel/status', 'GET');
      if (!data) return;
      updateTunnelUI(data);
    } catch (e) {}
  }

  function updateTunnelUI(data) {
    tunnelDot.className = 'tunnel-dot ' + (data.status === 'connected' ? 'on' : data.status === 'connecting' ? 'connecting' : 'off');
    if (data.status === 'connected' && data.url) {
      tunnelUrlEl.textContent = data.url;
      tunnelBtn.textContent = 'Ferma Tunnel';
      tunnelBtn.className = 'btn-tunnel stop';
      // Generate QR for tunnel URL
      tunnelQr.style.display = '';
      api(`/api/events/${document.querySelector('.event-card')?.dataset?.slug || '_'}/qr`, 'GET').catch(() => {});
    } else if (data.status === 'connecting') {
      tunnelUrlEl.textContent = 'Connessione in corso...';
      tunnelBtn.disabled = true;
    } else {
      tunnelUrlEl.textContent = 'Non attivo - il pubblico non puo collegarsi';
      tunnelBtn.textContent = 'Avvia Tunnel';
      tunnelBtn.className = 'btn-tunnel start';
      tunnelBtn.disabled = false;
      tunnelQr.style.display = 'none';
    }
    if (data.error) {
      tunnelUrlEl.textContent = 'Errore: ' + data.error;
    }
  }

  window.toggleTunnel = async function () {
    const dot = tunnelDot.className;
    if (dot.includes('on')) {
      await api('/api/tunnel/stop', 'POST');
    } else {
      tunnelDot.className = 'tunnel-dot connecting';
      tunnelUrlEl.textContent = 'Connessione in corso...';
      tunnelBtn.disabled = true;
      await api('/api/tunnel/start', 'POST');
      tunnelBtn.disabled = false;
    }
    checkTunnelStatus();
  };

  loadEvents();
  checkTunnelStatus();
  setInterval(loadEvents, 10000);
  setInterval(checkTunnelStatus, 5000);
})();
