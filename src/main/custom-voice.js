'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LANGUAGES = { qwen: ['fr', 'en', 'es', 'pt', 'ru', 'de', 'it', 'zh', 'ja', 'ko'],
  'gpt-sovits': ['en', 'zh', 'ja', 'ko', 'yue'] };
const MAX_REFERENCE = 1_200_000;
const MAX_AUDIO = 12_000_000;

function parseWave(input, { min = 3, max = 12, signal = true } = {}) {
  const bytes = Buffer.from(input);
  if (bytes.length < 44 || bytes.length > MAX_AUDIO || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Fichier WAV invalide.');
  let format, pcm;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    const end = at + 8 + size;
    if (end > bytes.length) throw new Error('Fichier WAV tronqué.');
    const kind = bytes.toString('ascii', at, at + 4);
    if (kind === 'fmt ') {
      if (size < 16) throw new Error('Format WAV invalide.');
      format = { code: bytes.readUInt16LE(at + 8), channels: bytes.readUInt16LE(at + 10),
        rate: bytes.readUInt32LE(at + 12), bytesPerSecond: bytes.readUInt32LE(at + 16),
        align: bytes.readUInt16LE(at + 20), bits: bytes.readUInt16LE(at + 22) };
    }
    if (kind === 'data') pcm = bytes.subarray(at + 8, end);
    at = end + (size % 2);
  }
  if (!format || !pcm || format.code !== 1 || format.channels !== 1 || format.bits !== 16
    || ![16000, 22050, 24000, 32000, 44100, 48000].includes(format.rate)
    || format.align !== 2 || format.bytesPerSecond !== format.rate * 2 || pcm.length % 2) throw new Error('Utilise un WAV mono PCM 16 bits.');
  const seconds = pcm.length / (format.rate * 2);
  if (seconds < min || seconds > max) throw new Error(`L’extrait doit durer entre ${min} et ${max} secondes.`);
  let power = 0;
  for (let at = 0; at < pcm.length; at += 2) power += (pcm.readInt16LE(at) / 32768) ** 2;
  if (signal && Math.sqrt(power / (pcm.length / 2)) < 0.003) throw new Error('L’extrait est silencieux ou trop faible.');
  const output = Buffer.alloc(44 + pcm.length);
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(format.rate, 24); output.writeUInt32LE(format.rate * 2, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write('data', 36);
  output.writeUInt32LE(pcm.length, 40); pcm.copy(output, 44);
  return { bytes: output, seconds, sampleRate: format.rate };
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim().slice(0, max) : '';
}

class CustomVoiceService {
  constructor({ root, runtime, scripts, progress = () => {} }) {
    this.root = root; this.runtime = runtime; this.scripts = scripts; this.progress = progress;
    this.worker = null; this.starting = null; this.pending = new Map(); this.installing = null;
    this.installNote = ''; this.installError = ''; this.workerDevice = '';
    this.forceCPU = false;
    this.workerEpoch = 0;
  }
  profiles() {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.root, 'voices.json'), 'utf8'));
      return Array.isArray(data) ? data.filter((p) => ID.test(p.id) && LANGUAGES[p.engine]?.includes(p.language)).slice(0, 12) : [];
    } catch { return []; }
  }
  write(profiles) {
    fs.mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, 'voices.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(profiles, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  state() {
    return { profiles: this.profiles().map(({ id, name, engine, language, testedAt }) => ({ id, name, engine, language, testedAt })),
      ready: fs.existsSync(path.join(this.runtime, 'ready.json')) && fs.existsSync(this.python())
        && ['config.json', 'model.safetensors', 'speech_tokenizer/model.safetensors'].every((file) => fs.existsSync(path.join(this.runtime, 'model', file))),
      installing: Boolean(this.installing), progress: this.installNote, error: this.installError,
      device: this.workerDevice, languages: LANGUAGES };
  }
  python() { return path.join(this.runtime, 'env', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'); }
  create(request) {
    if (request?.consent !== true) throw new Error('Confirme que tu as le droit d’utiliser cet extrait.');
    const engine = request.engine;
    if (!LANGUAGES[engine]?.includes(request.language)) throw new Error('Cette langue n’est pas prise en charge par ce moteur.');
    const name = cleanText(request.name, 48), transcript = cleanText(request.transcript, 600);
    if (!name || !transcript) throw new Error('Indique un nom et la transcription exacte de l’extrait.');
    if (!(request.audio instanceof Uint8Array) || request.audio.byteLength > MAX_REFERENCE) throw new Error('Extrait audio trop volumineux.');
    const audio = parseWave(request.audio);
    const profiles = this.profiles();
    if (profiles.length >= 12) throw new Error('Supprime une voix avant d’en ajouter une autre (12 maximum).');
    const id = randomUUID();
    const profile = { id, name, transcript, engine, language: request.language, consent: true,
      port: engine === 'gpt-sovits' ? Number(request.port || 9880) : undefined,
      seconds: audio.seconds, createdAt: new Date().toISOString(), testedAt: null };
    if (engine === 'gpt-sovits' && (!Number.isInteger(profile.port) || profile.port < 1024 || profile.port > 65535)) throw new Error('Port local invalide.');
    fs.mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, id + '.wav');
    fs.writeFileSync(file, audio.bytes, { flag: 'wx', mode: 0o600 });
    try { this.write([...profiles, profile]); } catch (error) { fs.unlinkSync(file); throw error; }
    return id;
  }
  remove(id) {
    if (!ID.test(id)) throw new Error('Profil invalide.');
    this.write(this.profiles().filter((p) => p.id !== id));
    const file = path.join(this.root, id + '.wav');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  tested(id) {
    this.write(this.profiles().map((p) => p.id === id ? { ...p, testedAt: new Date().toISOString() } : p));
  }
  prepare(basePython) {
    if (this.installing) return;
    if (!fs.existsSync(basePython)) throw new Error('Python 3.11 à 3.13 est nécessaire.');
    this.installError = ''; this.installNote = 'Préparation du moteur français…';
    const child = spawn(basePython, ['-I', '-X', 'utf8', '-u', path.join(this.scripts, 'prepare.py'), '--root', this.runtime],
      { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', HF_HUB_DISABLE_TELEMETRY: '1' } });
    this.installing = child;
    let buffer = '';
    child.stdout.on('data', (data) => {
      buffer += data.toString();
      if (buffer.length > 100000) buffer = buffer.slice(-10000);
      for (let at; (at = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try { const msg = JSON.parse(line); this.installNote = msg.progress || this.installNote; if (msg.error) this.installError = msg.error; } catch {}
        this.progress(this.state());
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', (error) => { this.installError = error.message; });
    child.on('close', (code) => {
      this.installing = null;
      if (code !== 0 && !this.installError) this.installError = 'Préparation interrompue. Tu peux réessayer.';
      this.progress(this.state());
    });
  }
  stop() {
    this.workerEpoch++;
    if (this.worker) this.worker.kill();
    this.worker = null; this.starting = null; this.workerDevice = '';
    for (const request of this.pending.values()) request.reject(new Error('Synthèse interrompue.'));
    this.pending.clear();
  }
  shutdown() {
    this.stop();
    const child = this.installing;
    if (child && child.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
      else child.kill();
    }
  }
  ensureWorker() {
    if (this.starting) return this.starting;
    if (!this.state().ready) return Promise.reject(new Error('Prépare le moteur français dans Créer une voix.'));
    const epoch = this.workerEpoch;
    this.starting = new Promise((resolve, reject) => {
      const child = spawn(this.python(), ['-I', '-X', 'utf8', '-u', path.join(this.scripts, 'worker.py'), '--model', path.join(this.runtime, 'model'), '--references', this.root, ...(this.forceCPU ? ['--cpu'] : [])],
        { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' } });
      this.worker = child;
      let buffer = '', errorNote = '', ready = false;
      const timeout = setTimeout(() => { reject(new Error('Le moteur vocal met trop longtemps à démarrer.')); if (this.worker === child) this.stop(); }, 180000);
      child.stderr.on('data', (data) => { errorNote = (errorNote + data.toString()).slice(-2000); });
      child.stdout.on('data', (data) => {
        if (this.worker !== child) return;
        buffer += data.toString();
        if (buffer.length > MAX_AUDIO * 2) { this.stop(); return; }
        for (let at; (at = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.kind === 'ready') { ready = true; clearTimeout(timeout); this.workerDevice = msg.device; resolve(child); }
          else if (msg.kind === 'fatal') { errorNote = msg.error; child.kill(); }
          else if (msg.id && this.pending.has(msg.id)) {
            const pending = this.pending.get(msg.id); this.pending.delete(msg.id);
            if (msg.kind === 'result' && typeof msg.audio === 'string' && msg.audio.length <= MAX_AUDIO * 1.4) pending.resolve(Buffer.from(msg.audio, 'base64'));
            else { const error = new Error(cleanText(msg.error, 500) || 'La synthèse vocale a échoué.'); error.code = msg.code; pending.reject(error); }
          }
        }
      });
      child.on('error', reject);
      child.stdin.on('error', () => { if (this.worker === child) this.stop(); });
      child.on('close', () => {
        clearTimeout(timeout);
        if (!ready) reject(new Error(cleanText(errorNote, 500) || 'Impossible de démarrer le moteur vocal.'));
        if (this.worker === child) this.stop();
      });
    }).catch((error) => { if (this.workerEpoch === epoch) this.starting = null; throw error; });
    return this.starting;
  }
  async synthesize(id, text, language, signal) {
    const profile = this.profiles().find((p) => p.id === id);
    if (!profile) throw new Error('Choisis une voix dans Créer une voix.');
    text = cleanText(text, 600); language = String(language || profile.language).split('-')[0];
    if (!text || !LANGUAGES[profile.engine]?.includes(language)) throw new Error('La voix choisie ne prend pas cette langue en charge.');
    if (signal?.aborted) throw new Error('Synthèse interrompue.');
    let bytes;
    if (profile.engine === 'gpt-sovits') {
      if (!Number.isInteger(profile.port) || profile.port < 1024 || profile.port > 65535) throw new Error('Port local invalide.');
      const response = await fetch(`http://127.0.0.1:${profile.port}/tts`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]),
        body: JSON.stringify({ text, text_lang: language, ref_audio_path: path.join(this.root, profile.id + '.wav'),
          prompt_text: profile.transcript, prompt_lang: profile.language, text_split_method: 'cut5', media_type: 'wav', streaming_mode: false, batch_size: 1 }) });
      if (!response.ok) throw new Error('GPT-SoVITS local ne répond pas correctement. Vérifie son démarrage.');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > MAX_AUDIO) throw new Error('Audio généré trop volumineux.'); chunks.push(chunk); }
      bytes = Buffer.concat(chunks);
    } else {
      const abort = () => this.stop();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const child = await this.ensureWorker();
        if (signal?.aborted) throw new Error('Synthèse interrompue.');
        if (this.pending.size) throw new Error('Une synthèse est déjà en cours.');
        bytes = await new Promise((resolve, reject) => {
          const requestId = randomUUID();
          const timeout = setTimeout(() => { this.stop(); reject(new Error('La génération a dépassé trois minutes.')); }, 180000);
          const done = (fn) => (value) => { clearTimeout(timeout); fn(value); };
          this.pending.set(requestId, { resolve: done(resolve), reject: done(reject) });
          child.stdin.write(JSON.stringify({ id: requestId, profile: profile.id, text, language, transcript: profile.transcript }) + '\n');
        });
      } catch (error) {
        if (error.code === 'cuda' && !this.forceCPU && !signal?.aborted) {
          this.forceCPU = true; this.stop();
          return await this.synthesize(id, text, language, signal);
        }
        throw error;
      } finally { signal?.removeEventListener('abort', abort); }
    }
    return new Uint8Array(parseWave(bytes, { min: 0.05, max: 120, signal: false }).bytes);
  }
}

module.exports = { CustomVoiceService, parseWave, LANGUAGES };
