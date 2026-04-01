const localtunnel = require('localtunnel');

let tunnel = null;
let tunnelUrl = null;
let tunnelStatus = 'stopped'; // stopped, connecting, connected, error
let tunnelError = null;

async function startTunnel(port) {
  if (tunnel) return { url: tunnelUrl, status: tunnelStatus };

  tunnelStatus = 'connecting';
  tunnelError = null;

  try {
    tunnel = await localtunnel({ port });
    tunnelUrl = tunnel.url;
    tunnelStatus = 'connected';

    console.log(`Tunnel attivo: ${tunnelUrl}`);

    tunnel.on('close', () => {
      tunnel = null;
      tunnelUrl = null;
      tunnelStatus = 'stopped';
      console.log('Tunnel chiuso');
    });

    tunnel.on('error', (err) => {
      tunnelError = err.message;
      tunnelStatus = 'error';
      console.error('Tunnel error:', err.message);
    });

    return { url: tunnelUrl, status: tunnelStatus };
  } catch (err) {
    tunnelError = err.message;
    tunnelStatus = 'error';
    tunnel = null;
    console.error('Failed to start tunnel:', err.message);
    return { url: null, status: tunnelStatus, error: tunnelError };
  }
}

function stopTunnel() {
  if (tunnel) {
    tunnel.close();
    tunnel = null;
    tunnelUrl = null;
    tunnelStatus = 'stopped';
    tunnelError = null;
  }
  return { status: 'stopped' };
}

function getTunnelStatus() {
  return {
    status: tunnelStatus,
    url: tunnelUrl,
    error: tunnelError,
  };
}

function setupTunnelRoutes(app, port) {
  app.post('/api/tunnel/start', async (req, res) => {
    const result = await startTunnel(port);
    res.json(result);
  });

  app.post('/api/tunnel/stop', (req, res) => {
    const result = stopTunnel();
    res.json(result);
  });

  app.get('/api/tunnel/status', (req, res) => {
    res.json(getTunnelStatus());
  });
}

module.exports = { setupTunnelRoutes, startTunnel, stopTunnel, getTunnelStatus };
