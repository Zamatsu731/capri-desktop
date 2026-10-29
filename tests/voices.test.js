'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const http=require('node:http');const {once}=require('node:events');
const vm=require('node:vm');
const {CustomVoiceService,parseWave}=require('../src/main/custom-voice');
function wav(seconds=3.2,silent=false){const b=Buffer.alloc(44+Math.round(seconds*24000)*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);if(!silent)for(let i=44;i<b.length;i+=2)b.writeInt16LE(Math.round(Math.sin(i*0.03)*8000),i);return b;}
function service(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'capri-voice-test-'));t.after(()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'capri-voice-test-')));fs.rmSync(root,{recursive:true,force:true});});return new CustomVoiceService({root,runtime:path.join(root,'runtime'),scripts:root});}
function renderer(host){const source=fs.readFileSync(path.join(__dirname,'../src/renderer/js/voice.js'),'utf8').replace(/^import .*;$/m,'const rand=()=>0; const pick=a=>a[0];').replace(/export /g,'');const context={window:{host},setTimeout,clearTimeout,Uint8Array};vm.createContext(context);vm.runInContext(source+'\nglobalThis.Voice=Voice;',context);return new context.Voice();}

test('interrupting an old synthesis cannot clear the new request or play stale audio',async()=>{
  const pending=[];const cancelled=[];
  const voice=renderer({synthesizeCustomVoice:request=>new Promise((resolve,reject)=>pending.push({...request,resolve,reject})),cancelCustomVoice:id=>cancelled.push(id)});
  voice.configure({customVoiceId:'local-profile'});
  voice.ensure=()=>{throw Error('stale audio reached playback');};
  const first=voice.speak('Première phrase.');const second=voice.speak('Deuxième phrase.');
  assert.deepEqual(cancelled,[pending[0].id]);pending[0].reject(Error('cancelled'));assert.equal(await first,true);
  assert.equal(voice.customRequest,pending[1].id);
  voice.stopSpeech();pending[1].resolve({ok:true,audio:new Uint8Array([1])});assert.equal(await second,true);
  assert.deepEqual(cancelled,pending.map(p=>p.id));assert.equal(voice.lastSpeechError,'');
});

test('reference audio is bounded, audible PCM and unrelated WAV metadata is removed',()=>{
  const original=wav();assert.equal(parseWave(original).seconds,3.2);
  assert.throws(()=>parseWave(wav(2)),/entre/);assert.throws(()=>parseWave(wav(13)),/entre/);
  assert.throws(()=>parseWave(wav(4,true)),/silencieux/);
  const bad=wav();bad.writeUInt32LE(42,28);assert.throws(()=>parseWave(bad),/PCM/);
  const junk=Buffer.alloc(12);junk.write('JUNK');junk.writeUInt32LE(4,4);junk.write('test',8);
  const extra=Buffer.concat([original.subarray(0,36),junk,original.subarray(36)]);extra.writeUInt32LE(extra.length-8,4);
  assert.deepEqual(parseWave(extra).bytes,original);
});
test('a voice requires permission, supported language and an internal identifier',t=>{
  const s=service(t);const input={name:'Capri',engine:'qwen',language:'fr',transcript:'Bonjour, ceci est un exemple.',audio:wav(),consent:true};
  assert.throws(()=>s.create({...input,consent:false}),/droit/);
  assert.throws(()=>s.create({...input,engine:'gpt-sovits'}),/langue/);
  const id=s.create({...input,testedAt:'injected'});assert.equal(s.profiles()[0].testedAt,null);
  assert.ok(fs.existsSync(path.join(s.root,id+'.wav')));
  assert.throws(()=>s.remove('../voices.json'),/invalide/);
  s.tested(id);assert.ok(s.profiles()[0].testedAt);s.remove(id);assert.equal(s.profiles().length,0);
});

test('stored GPT ports are validated again and unsupported French never reaches a server',async t=>{
  const s=service(t);const id=s.create({name:'GPT',engine:'gpt-sovits',language:'en',transcript:'Hello world.',audio:wav(),consent:true,port:9880});
  await assert.rejects(s.synthesize(id,'Bonjour','fr'),/langue/);
  s.write(s.profiles().map(p=>({...p,port:'9880@example.com'})));
  await assert.rejects(s.synthesize(id,'Hello','en'),/Port local/);
});
test('GPT-SoVITS receives only the documented local TTS request and redirects are rejected',async t=>{
  let received;let redirect=false;
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);received={path:req.url,body:JSON.parse(Buffer.concat(chunks))};if(redirect){res.writeHead(302,{Location:'https://example.invalid/tts'});res.end();}else{res.writeHead(200,{'content-type':'audio/wav'});res.end(wav(1));}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const s=service(t);const id=s.create({name:'GPT',engine:'gpt-sovits',language:'en',transcript:'Hello world.',audio:wav(),consent:true,port:server.address().port});
  const output=await s.synthesize(id,'Hello Capri','en');assert.ok(output instanceof Uint8Array);
  assert.equal(received.path,'/tts');assert.equal(received.body.streaming_mode,false);assert.equal(received.body.text_lang,'en');
  assert.equal(received.body.ref_audio_path,path.join(s.root,id+'.wav'));
  redirect=true;await assert.rejects(s.synthesize(id,'Hello Capri','en'));
});
