const { spawn } = require('child_process');
const { bin, install } = require('cloudflared');
const fs = require('fs');

let tunnelProcess = null;
let tunnelUrl = null;
let tunnelStatus = 'stopped';
let tunnelError = null;

async function startTunnel(port) {
  if (tunnelProcess && tunnelStatus === 'connected') return { url: tunnelUrl, status: tunnelStatus };

  tunnelStatus = 'connecting';
  tunnelError = null;

  try {
    // Ensure cloudflared binary is installed
    if (!fs.existsSync(bin)) {
      console.log('Installing cloudflared binary...');
      await install(bin);
      console.log('cloudflared installed at', bin);
    }

    // Spawn cloudflared directly
    const child = spawn(bin, ['tunnel', '--url', `localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    tunnelProcess = child;

    // Parse URL from stderr output (cloudflared logs to stderr)
    tunnelUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout: cloudflared non riesce a connettersi')), 30000);
      let output = '';

      function parseLine(data) {
        output += data.toString();
        // Look for the tunnel URL in output
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      }

      child.stdout.on('data', parseLine);
      child.stderr.on('data', parseLine);

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.on('exit', (code) => {
        if (!tunnelUrl) {
          clearTimeout(timeout);
          reject(new Error(`cloudflared exited with code ${code}`));
        }
      });
    });

    tunnelStatus = 'connected';
    console.log(`Tunnel Cloudflare attivo: ${tunnelUrl}`);

    child.on('exit', (code) => {
      console.log('Tunnel chiuso, exit code:', code);
      tunnelProcess = null;
      tunnelUrl = null;
      tunnelStatus = 'stopped';
    });

    return { url: tunnelUrl, status: tunnelStatus };
  } catch (err) {
    tunnelError = err.message || String(err);
    tunnelStatus = 'error';
    if (tunnelProcess) { try { tunnelProcess.kill(); } catch(e) {} }
    tunnelProcess = null;
    tunnelUrl = null;
    console.error('Failed to start Cloudflare tunnel:', tunnelError);
    return { url: null, status: tunnelStatus, error: tunnelError };
  }
}

async function stopTunnel() {
  if (tunnelProcess) {
    try { tunnelProcess.kill(); } catch(e) {}
    tunnelProcess = null;
  }
  tunnelUrl = null;
  tunnelStatus = 'stopped';
  tunnelError = null;
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

  app.post('/api/tunnel/stop', async (req, res) => {
    const result = await stopTunnel();
    res.json(result);
  });

  app.get('/api/tunnel/status', (req, res) => {
    res.json(getTunnelStatus());
  });
}

module.exports = { setupTunnelRoutes, startTunnel, stopTunnel, getTunnelStatus };
