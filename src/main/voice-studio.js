'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { CustomVoiceService, LANGUAGES } = require('./custom-voice');
const URL = 'capri://app/src/renderer/voice-studio.html';

function createVoiceStudio({ config, updateConfig, language }) {
  let window = null;
  const requests = new Map();
  const runtime = path.join(app.getPath('documents'), 'Codex', 'capri-voice-engine');
  const appRoot = app.getAppPath();
  const scripts = path.join(app.isPackaged ? appRoot.replace(/app\.asar$/, 'app.asar.unpacked') : appRoot, 'scripts', 'voice');
  const service = new CustomVoiceService({ root: path.join(app.getPath('userData'), 'voices'), runtime, scripts,
    progress: (state) => window?.webContents.send('voice-studio:progress', state) });
  const state = () => ({ ...service.state(), active: config.load().customVoiceId || '', readTyped: config.load().speakTypedReplies === true });
  const trusted = (event) => window && event.sender === window.webContents
    && event.senderFrame === event.sender.mainFrame && event.senderFrame?.url === URL;
  const handle = (name, fn) => ipcMain.handle('voice-studio:' + name, async (event, ...args) => {
    if (!trusted(event)) throw new Error('denied');
    try { return { ok: true, ...(await fn(...args)) }; }
    catch (error) { return { ok: false, error: String(error.message).slice(0, 600) }; }
  });
  handle('state', state);
  handle('prepare', () => {
    const python = [process.env.CAPRI_VOICE_PYTHON,
      ...['313', '312', '311'].map((v) => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python' + v, 'python.exe'))]
      .find((file) => file && path.isAbsolute(file) && fs.existsSync(file));
    if (!python) throw new Error('Installe Python depuis python.org, puis relance Capri.');
    const disk = fs.statfsSync(app.getPath('documents'));
    if (disk.bavail * disk.bsize < 8e9) throw new Error('Libère au moins 8 Go avant de préparer le moteur.');
    service.prepare(python);
    return state();
  });
  handle('create', (request) => ({ id: service.create(request), ...state() }));
  handle('test', async ({ id, text }) => {
    const profile = service.profiles().find((p) => p.id === id);
    if (!profile) throw new Error('Choisis un profil vocal.');
    const audio = await service.synthesize(id, text, profile.language);
    service.tested(id);
    return { audio, ...state() };
  });
  handle('activate', ({ id = '', readTyped = true } = {}) => {
    if (id) {
      const profile = service.profiles().find((p) => p.id === id && p.testedAt);
      if (!profile) throw new Error('Teste cette voix avant de l’activer.');
      if (!LANGUAGES[profile.engine].includes(language())) throw new Error('Ce moteur ne prend pas la langue actuelle de Capri en charge. Choisis Qwen3-TTS pour le français.');
    }
    updateConfig({ customVoiceId: id, speakTypedReplies: Boolean(id && readTyped) });
    return state();
  });
  handle('delete', async (id) => {
    if (!service.profiles().some((p) => p.id === id)) throw new Error('Profil introuvable.');
    const result = await dialog.showMessageBox(window, { type: 'question', buttons: ['Supprimer', 'Annuler'], defaultId: 1, cancelId: 1,
      message: 'Supprimer ce profil vocal et son extrait de référence ?' });
    if (result.response === 0) {
      service.stop();
      if (config.load().customVoiceId === id) updateConfig({ customVoiceId: '', speakTypedReplies: false });
      service.remove(id);
    }
    return state();
  });
  handle('stop', () => { service.stop(); return {}; });
  handle('docs', (name) => {
    const links = { gpt: 'https://github.com/RVC-Boss/GPT-SoVITS', qwen: 'https://github.com/QwenLM/Qwen3-TTS', python: 'https://www.python.org/downloads/' };
    if (links[name]) void shell.openExternal(links[name]);
    return {};
  });

  return {
    service,
    get webContents() { return window?.webContents; },
    open() {
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
      window = new BrowserWindow({ width: 700, height: 820, minWidth: 560, minHeight: 600, show: false,
        title: 'Créer une voix · Capri', backgroundColor: '#15101f', autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, '..', 'voice-preload.js'), contextIsolation: true,
          nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' } });
      window.setAlwaysOnTop(true, 'screen-saver');
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const event of ['will-navigate', 'will-redirect']) window.webContents.on(event, (e, url) => { if (url !== URL) e.preventDefault(); });
      window.loadURL(URL);
      window.once('ready-to-show', () => window?.show());
      window.on('closed', () => { window = null; });
    },
    async synthesize(event, { id, text, lang }) {
      if (!Number.isSafeInteger(id) || id < 1 || typeof text !== 'string' || text.length > 1600) return { ok: false, error: 'invalid-request' };
      const key = event.sender.id + ':' + id;
      const abort = new AbortController(); requests.set(key, abort);
      try { return { ok: true, audio: await service.synthesize(config.load().customVoiceId, text, lang, abort.signal) }; }
      catch (error) { return { ok: false, error: String(error.message).slice(0, 600) }; }
      finally { requests.delete(key); }
    },
    cancel(event, id) { requests.get(event.sender.id + ':' + id)?.abort(); },
    close() { for (const abort of requests.values()) abort.abort(); service.shutdown(); },
  };
}
module.exports = { createVoiceStudio };
