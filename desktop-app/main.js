// main.js — Electron ana süreci. Canlı Render sitesini native bir pencerede açar.
// Sunucu tarafında hiçbir şey değişmez; bu sadece o siteyi çevreleyen bir "kabuk".
const { app, BrowserWindow, shell } = require('electron');

const UYGULAMA_URL = 'https://intern-tasks-pannel.onrender.com/';

function pencereOlustur() {
  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'Görevlendirme & Takip Paneli',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadURL(UYGULAMA_URL);

  // target="_blank" gibi yeni pencere isteklerini Electron içinde değil, varsayılan
  // tarayıcıda aç (ör. Google Takvim bağlama akışı).
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  pencereOlustur();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) pencereOlustur();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
