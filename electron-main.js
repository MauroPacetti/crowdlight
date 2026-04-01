const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const { startServer, PORT } = require('./server');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'CrowdLight',
    icon: path.join(__dirname, 'public', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#0d0d0d',
  });

  // Load dashboard directly
  mainWindow.loadURL(`http://localhost:${PORT}/dashboard`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Simple menu
  const menu = Menu.buildFromTemplate([
    {
      label: 'CrowdLight',
      submenu: [
        { label: 'Dashboard', click: () => mainWindow.loadURL(`http://localhost:${PORT}/dashboard`) },
        { type: 'separator' },
        { label: 'DevTools', accelerator: 'F12', click: () => mainWindow.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'quit', label: 'Esci' },
      ],
    },
    {
      label: 'Visualizza',
      submenu: [
        { role: 'reload', label: 'Ricarica' },
        { role: 'zoomIn', label: 'Zoom +' },
        { role: 'zoomOut', label: 'Zoom -' },
        { role: 'resetZoom', label: 'Zoom Reset' },
        { role: 'togglefullscreen', label: 'Schermo intero' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  startServer(() => {
    console.log('Server ready, opening window...');
    createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
