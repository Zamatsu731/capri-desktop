'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { TRAY } = require('../src/main/labels');

function moduleUrl(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${moduleUrl(path.resolve(path.dirname(file), relative))}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
const pack = import(moduleUrl(path.join(__dirname, '../src/renderer/js/animation-pack.js')));
const clock = import(moduleUrl(path.join(__dirname, '../src/renderer/js/render-clock.js')));

test('the render clock maintains 60 fps phase on 60, 75, 120, 144 and 240 Hz displays', async () => {
  const { renderTime } = await clock;
  for (const hz of [60,75,120,144,240]) {
    let previous=0,draws=0;
    for(let i=1;i<=hz*3;i++){
      const time=renderTime(i*1000/hz,previous,1000/60);
      if(time!==null){previous=time;draws++;}
    }
    assert.ok(draws>=179&&draws<=181,`${hz} Hz: ${draws} draws in three seconds`);
  }
  assert.equal(renderTime(5,0,1000/60),null);
  assert.ok(Number.isFinite(renderTime(60000,0,1000/60)),'resume without catch-up loop');
});

test('repeated sprite frames reuse hit masks with bounded memory', async () => {
  const {AnimationPack}=await pack;const instance=Object.create(AnimationPack.prototype);let reads=0;
  Object.assign(instance,{enabled:true,active:false,images:new Map([['idle',{}]]),alphaFrames:new Map(),nextBlink:Infinity,selection:'',started:0,key:'',generation:0,
    canvas:{width:352,height:532},ctx:{clearRect(){},drawImage(){},getImageData(){reads++;return {data:new Uint8Array([0,0,0,255])};}}});
  const state={stance:'stand',mode:'idle',reduced:false};
  for(let i=0;i<48;i++)instance.frame(state,i*125);
  assert.equal(reads,16,'three cycles require just one readback per drawing');
  assert.equal(instance.alphaFrames.size,16);
  for(let i=0;i<40;i++){
    instance.images.set('dangle',{});instance.override={name:'dangle',start:0};instance.frame({...state,stance:'held'},i*100);
  }
  assert.equal(instance.alphaFrames.size,24);
});

test('all 20 packaged clips match the fixed source manifest and contain only validated PNG image chunks', async () => {
  const { CLIPS } = await pack;
  const dir = path.join(__dirname, '../assets/capri/lachy');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.commit, '0b2dd14cdc2ad617cb5d76a06b764d9aaf72968f');
  assert.equal(manifest.files.length, 20);
  assert.equal(manifest.files.reduce((sum, file) => sum + file.frames, 0), 238);
  assert.deepEqual(manifest.files.map((f) => f.name).sort(), Object.keys(CLIPS).sort());
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(dir, `${file.name}.png`));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), file.sha256, file.name);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), CLIPS[file.name].width * CLIPS[file.name].count);
    assert.equal(bytes.readUInt32BE(20), 384);
    const color = bytes[25];
    assert.ok(color === 3 || color === 6);
    let offset = 8;
    const compressed = [];
    let last;
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const kind = bytes.toString('ascii', offset + 4, offset + 8);
      assert.ok(['IHDR', 'IDAT', 'IEND', 'PLTE', 'tRNS', 'sRGB', 'gAMA', 'cHRM'].includes(kind), `${file.name}: ${kind}`);
      assert.ok(offset + 12 + length <= bytes.length);
      if (kind === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
      last = kind;
    }
    assert.equal(last, 'IEND');
    assert.equal(offset, bytes.length);
    const stride = 1 + bytes.readUInt32BE(16) * (color === 6 ? 4 : 1);
    const decoded = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: stride * 384 });
    assert.equal(decoded.length, stride * 384);
    for (let row = 0; row < 384; row++) assert.ok(decoded[row * stride] <= 4);
  }
  for (const labels of Object.values(TRAY)) {
    assert.deepEqual(Object.keys(labels.animationNames).sort(), Object.keys(CLIPS).sort());
  }
});

test('everyday sprite states preserve pointing, celebrations, airborne physics and busy actions', async () => {
  const { restingClip } = await pack;
  assert.equal(restingClip({ stance: 'stand', mode: 'idle' }), 'idle');
  assert.equal(restingClip({ stance: 'sit', mode: 'work' }), 'perch');
  assert.equal(restingClip({ stance: 'held' }), 'dangle');
  assert.equal(restingClip({ stance: 'stand', mode: 'sleep' }), 'sleep');
  assert.equal(restingClip({ stance: 'stand', act: 'talk' }), 'idle');
  assert.equal(restingClip({ stance: 'stand', act: 'victory' }), null);
  assert.equal(restingClip({ stance: 'stand', pointing: true }), null);
  assert.equal(restingClip({ stance: 'stand', busy: true }), null);
  for (const stance of ['fly', 'down', 'fall', 'peek']) assert.equal(restingClip({ stance }), null);
});

test('reduced motion stops frame cycling and arbitrary paths cannot become animation sources', async () => {
  const { CLIPS, hasClip, frameNumber } = await pack;
  for (const name of ['../idle', '__proto__', 'constructor', 'https://example.com/a.png', null]) {
    assert.equal(hasClip(name), false);
  }
  for (const name of Object.keys(CLIPS)) {
    assert.equal(frameNumber(name, 12345, true), 0);
    assert.equal(frameNumber(name, -100), 0);
    assert.ok(frameNumber(name, 12345) < CLIPS[name].count);
  }
});

test('disabling the pack cancels a pending load even if it is enabled again before loading completes', async () => {
  const { AnimationPack } = await pack;
  const instance = Object.create(AnimationPack.prototype);
  Object.assign(instance, { enabled: true, playSerial: 0, override: null });
  let finishLoad;
  instance.load = () => new Promise((resolve) => { finishLoad = resolve; });
  const playing = instance.play('idle');
  instance.configure(false);
  instance.configure(true);
  finishLoad({});
  assert.equal(await playing, false);
  assert.equal(instance.override, null);
});
