const { nanoid } = require('nanoid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { stmts } = require('../db');
const { requireAuth } = require('../auth');
const { getTunnelStatus } = require('../tunnel');

function setupEventRoutes(app, getEventStats) {
  // List user's events
  app.get('/api/events', requireAuth, (req, res) => {
    const events = stmts.getEventsByUser.all(req.user.id);
    // Add live stats
    const enriched = events.map(ev => ({
      ...ev,
      is_active: !!ev.is_active,
      stats: getEventStats(ev.slug),
    }));
    res.json({ events: enriched });
  });

  // Create event
  app.post('/api/events', requireAuth, (req, res) => {
    const { name, numGroups, maxAudience } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome evento richiesto' });
    }

    const slug = nanoid(8);
    const controllerToken = crypto.randomBytes(24).toString('hex');
    const groups = Math.min(Math.max(Number(numGroups) || 10, 1), 50);
    const audience = Math.min(Math.max(Number(maxAudience) || 500, 10), 50000);

    try {
      stmts.createEvent.run(slug, req.user.id, name.trim(), groups, audience, controllerToken);
    } catch (err) {
      if (err.message.includes('FOREIGN KEY')) {
        return res.status(401).json({ error: 'Sessione scaduta. Esci e accedi di nuovo.' });
      }
      throw err;
    }

    const event = stmts.getEventBySlug.get(slug);
    res.json({
      event: {
        ...event,
        is_active: !!event.is_active,
      }
    });
  });

  // Get event info (public - for audience page)
  app.get('/api/events/:slug', (req, res) => {
    const event = stmts.getEventBySlug.get(req.params.slug);
    if (!event) return res.status(404).json({ error: 'Evento non trovato' });

    res.json({
      event: {
        slug: event.slug,
        name: event.name,
        num_groups: event.num_groups,
        is_active: !!event.is_active,
        logo: event.logo || null,
        stats: getEventStats(event.slug),
      }
    });
  });

  // Update event
  app.put('/api/events/:slug', requireAuth, (req, res) => {
    const { name, numGroups, maxAudience, isActive } = req.body;
    const event = stmts.getEventBySlug.get(req.params.slug);
    if (!event) return res.status(404).json({ error: 'Evento non trovato' });
    if (event.user_id !== req.user.id) return res.status(403).json({ error: 'Non autorizzato' });

    const updatedName = (name || event.name).trim();
    const updatedGroups = Math.min(Math.max(Number(numGroups) || event.num_groups, 1), 50);
    const updatedAudience = Math.min(Math.max(Number(maxAudience) || event.max_audience, 10), 50000);
    const updatedActive = isActive !== undefined ? (isActive ? 1 : 0) : event.is_active;

    stmts.updateEvent.run(updatedName, updatedGroups, updatedAudience, updatedActive, req.params.slug, req.user.id);
    const updated = stmts.getEventBySlug.get(req.params.slug);
    res.json({ event: { ...updated, is_active: !!updated.is_active } });
  });

  // Delete event
  app.delete('/api/events/:slug', requireAuth, (req, res) => {
    const result = stmts.deleteEvent.run(req.params.slug, req.user.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Evento non trovato' });
    res.json({ ok: true });
  });

  // Upload event logo (base64)
  app.post('/api/events/:slug/logo', requireAuth, (req, res) => {
    const event = stmts.getEventBySlug.get(req.params.slug);
    if (!event) return res.status(404).json({ error: 'Evento non trovato' });
    if (event.user_id !== req.user.id) return res.status(403).json({ error: 'Non autorizzato' });

    const { logo } = req.body; // base64 data URL
    if (!logo) return res.status(400).json({ error: 'Logo richiesto' });

    // Save as file
    const matches = logo.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Formato immagine non valido' });

    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const filename = `event-${req.params.slug}.${ext}`;

    // Use AppData for packaged app, otherwise public/uploads
    let uploadsDir;
    if (__dirname.includes('app.asar') || __dirname.includes('Program Files')) {
      const appData = process.env.APPDATA || process.env.HOME || '';
      uploadsDir = path.join(appData, 'CrowdLight', 'uploads');
    } else {
      uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
    }
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const filepath = path.join(uploadsDir, filename);
    fs.writeFileSync(filepath, Buffer.from(matches[2], 'base64'));

    const logoUrl = `/uploads/${filename}`;
    stmts.updateEventLogo.run(logoUrl, req.params.slug, req.user.id);

    res.json({ logo: logoUrl });
  });

  // QR Code
  app.get('/api/events/:slug/qr', async (req, res) => {
    const event = stmts.getEventBySlug.get(req.params.slug);
    if (!event) return res.status(404).json({ error: 'Evento non trovato' });

    // Use tunnel URL if active, otherwise local
    const tunnel = getTunnelStatus();
    const baseUrl = (tunnel.status === 'connected' && tunnel.url) ? tunnel.url : `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/event/${event.slug}`;

    try {
      const qr = await QRCode.toDataURL(url, {
        width: 512,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      res.json({ qr, url });
    } catch (err) {
      res.status(500).json({ error: 'Errore generazione QR' });
    }
  });
}

module.exports = { setupEventRoutes };
