// Local sprite strips from lachydotmcg/capri-desktop. Only the PNG artwork is imported;
// this player has no desktop bridge, network service, or dynamically executable content.
import { SPRITE } from './sprite.js';

export const CLIPS = Object.freeze(Object.fromEntries([
  ['idle', 16, 8], ['blink', 4, 8], ['blink_glitch', 4, 8], ['grin', 16, 8],
  ['glitch', 10, 15], ['dangle', 24, 10], ['sleep', 16, 6], ['wake', 13, 15],
  ['walk', 12, 12], ['dance', 16, 8], ['arrive', 14, 15], ['leave', 12, 15],
  ['mouth', 5, 12], ['perch', 16, 8], ['perch_blink', 4, 8],
  ['perch_blink_glitch', 4, 8], ['perch_glitch', 10, 15], ['perch_dance', 16, 8],
  ['perch_arrive', 14, 15], ['perch_leave', 12, 15],
].map(([name, count, fps]) => [name, Object.freeze({
  count, fps, width: name.startsWith('perch') ? 384 : 240, height: 384,
  seated: name.startsWith('perch'),
})])));

export const hasClip = (name) => typeof name === 'string' && Object.hasOwn(CLIPS, name);
const FLASHING = /glitch|arrive|leave/;
const SAFE_ACTS = new Set(['talk', 'grabbed']);

// Selection is independent of the renderer so special acts always retain their original rig.
export function restingClip({ stance, mode, act, busy, pointing, override }) {
  if (pointing || (act && !SAFE_ACTS.has(act))) return null;
  if (!['stand', 'sit', 'held'].includes(stance)) return null;
  if (override) return override;
  if (busy) return null;
  if (stance === 'held') return 'dangle';
  if (mode === 'sleep') return stance === 'sit' ? null : 'sleep';
  return stance === 'sit' ? 'perch' : 'idle';
}

export function frameNumber(name, elapsed, reduced = false) {
  if (!hasClip(name)) return 0;
  const clip = CLIPS[name];
  return reduced ? 0 : Math.floor(Math.max(0, elapsed) * clip.fps / 1000) % clip.count;
}

export class AnimationPack {
  constructor() {
    this.enabled = true;
    this.images = new Map();
    this.loading = new Map();
    this.failed = new Set();
    this.alphaFrames = new Map(); // bounded hit-mask cache: avoid repeated canvas readbacks
    this.override = null;
    this.playSerial = 0;
    this.generation = 0;
    this.key = '';
    this.selection = '';
    this.started = 0;
    this.nextBlink = performance.now() + 4000;
    this.blink = null;
    this.active = false;
    this.fps = 12;
    this.canvas = document.createElement('canvas');
    this.canvas.width = SPRITE.width + SPRITE.pad * 2;
    this.canvas.height = SPRITE.height + SPRITE.pad * 2;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.alpha = null;
    void this.load('idle');
  }

  configure(enabled) {
    this.enabled = enabled !== false;
    if (!this.enabled) { this.cancel(); this.active = false; }
  }

  async load(name) {
    if (!hasClip(name) || this.failed.has(name)) return null;
    if (this.images.has(name)) return this.images.get(name);
    if (!this.loading.has(name)) {
      const promise = new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
          const clip = CLIPS[name];
          if (image.naturalWidth !== clip.width * clip.count || image.naturalHeight !== clip.height) {
            this.failed.add(name);
            resolve(null);
            return;
          }
          this.images.set(name, image);
          resolve(image);
        };
        image.onerror = () => { this.failed.add(name); resolve(null); };
        // The name comes from the fixed catalogue above, never from a user supplied URL or path.
        image.src = new URL(`../../assets/capri/lachy/${name}.png`, document.baseURI).href;
      }).finally(() => this.loading.delete(name));
      this.loading.set(name, promise);
    }
    return this.loading.get(name);
  }

  cancel() {
    this.playSerial++;
    const current = this.override;
    this.override = null;
    if (current) { clearTimeout(current.timer); current.done(false); }
  }

  async play(name, { duration = null, reduced = false, transition = false } = {}) {
    if (!this.enabled || !hasClip(name) || (reduced && FLASHING.test(name))) return false;
    this.cancel();
    const ticket = this.playSerial;
    const image = await this.load(name === 'mouth' ? 'idle' : name);
    if (!this.enabled || !image || ticket !== this.playSerial) return false;
    if (name === 'mouth') await this.load('mouth');
    if (!this.enabled || ticket !== this.playSerial) return false;
    const clip = CLIPS[name];
    const ms = reduced ? 900 : Math.min(6000, Math.max(300, duration ?? clip.count / clip.fps * 1000));
    return new Promise((done) => {
      const current = { name, start: performance.now(), done, timer: null, transition };
      this.override = current;
      this.fps = clip.fps;
      current.timer = setTimeout(() => {
        if (this.override === current) this.override = null;
        done(true);
      }, ms);
    });
  }

  geometry(name) {
    if (CLIPS[name].seated) {
      const scale = 1.1;
      return { x: SPRITE.feet.x - 115.2 * scale, y: SPRITE.hip - 303.36 * scale,
        w: 384 * scale, h: 384 * scale, headX: 210, headY: 193, top: 68 };
    }
    const scale = 1.22;
    return { x: SPRITE.feet.x - 140 * scale, y: SPRITE.feet.y - 363 * scale,
      w: 240 * scale, h: 384 * scale, headX: 136, headY: 124, top: 20 };
  }

  frame(state, now) {
    this.active = false;
    if (!this.enabled) return null;
    const requested = this.override?.name;
    let name = restingClip({ ...state, ...(this.override?.transition ? { act: null } : {}), override: requested });
    if (!name) return null;
    const speaking = state.talking || name === 'mouth';
    if (name === 'mouth') name = 'idle';
    // Motion preferences apply to this pack too, including manual previews.
    if (state.reduced && FLASHING.test(name)) name = CLIPS[name].seated ? 'perch' : 'idle';
    if (!requested && !speaking && !state.reduced && (name === 'idle' || name === 'perch')) {
      if (now >= this.nextBlink) {
        this.blink = { name: `${name === 'perch' ? 'perch_' : ''}blink${Math.random() < 0.18 ? '_glitch' : ''}`, start: now };
        this.nextBlink = now + 4000 + Math.random() * 5000;
      }
      if (this.blink && now - this.blink.start < 500) name = this.blink.name;
    } else this.blink = null;
    const image = this.images.get(name);
    if (!image) { void this.load(name); return null; }
    if (this.selection !== name) { this.selection = name; this.started = now; }
    const start = requested ? this.override.start : this.blink?.name === name ? this.blink.start : this.started;
    const index = frameNumber(name, now - start, state.reduced);
    const mouth = speaking && !CLIPS[name].seated && !state.reduced ? this.images.get('mouth') : null;
    if (speaking && !mouth && !CLIPS[name].seated) void this.load('mouth');
    const mouthIndex = mouth ? frameNumber('mouth', now - start) : -1;
    const key = `${name}:${index}:${mouthIndex}`;
    this.fps = CLIPS[name].fps;
    this.active = true;
    if (key !== this.key) {
      this.key = key;
      const clip = CLIPS[name];
      const rect = this.geometry(name);
      this.rect = rect;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const draw = (source, cell) => this.ctx.drawImage(source, cell * clip.width, 0, clip.width, clip.height,
        SPRITE.pad + rect.x, SPRITE.pad + rect.y, rect.w, rect.h);
      draw(image, index);
      if (mouth) draw(mouth, mouthIndex);
      let alpha = this.alphaFrames.get(key);
      if (alpha) this.alphaFrames.delete(key);
      else alpha = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
      this.alphaFrames.set(key, alpha);
      if (this.alphaFrames.size > 24) this.alphaFrames.delete(this.alphaFrames.keys().next().value);
      this.alpha = alpha;
      this.generation++;
    }
    return { image: this.canvas, version: this.generation };
  }

  hit(x, y) {
    if (!this.active || !this.alpha) return false;
    const px = Math.round(x + SPRITE.pad), py = Math.round(y + SPRITE.pad);
    if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) return false;
    return this.alpha[(py * this.canvas.width + px) * 4 + 3] > 40;
  }

  head() {
    if (!this.active || !this.rect) return null;
    const r = this.rect;
    return { x: r.x + r.headX * r.w / (CLIPS[this.selection].width),
      y: r.y + r.headY * r.h / 384, top: r.y + r.top * r.h / 384 };
  }
}
