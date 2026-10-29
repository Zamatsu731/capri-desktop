const api = window.voiceStudio;
const $ = (id) => document.getElementById(id);
const languageNames = { fr:'Français', en:'Anglais', es:'Espagnol', pt:'Portugais', ru:'Russe', de:'Allemand', it:'Italien', zh:'Chinois', ja:'Japonais', ko:'Coréen', yue:'Cantonais' };
let state, audioBytes, recording, stream, referenceUrl, previewUrl, busy = false;
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function result(value) { if (!value?.ok) throw new Error(value?.error || 'Cette action a échoué.'); return value; }
function refresh(next, selected = $('profiles').value) {
  state = { ...state, ...next };
  $('profiles').replaceChildren(...state.profiles.map((profile) => {
    const option = document.createElement('option'); option.value = profile.id;
    option.textContent = `${profile.name} · ${languageNames[profile.language] || profile.language}`; return option;
  }));
  if (state.profiles.some((p) => p.id === selected)) $('profiles').value = selected;
  $('prepare').disabled = state.ready || state.installing;
  $('engine-status').textContent = state.ready ? 'Le moteur français est prêt sur ce PC.' : state.installing ? 'Préparation en cours… Tu peux déjà choisir ton extrait.' : 'Le moteur français n’est pas encore préparé.';
  $('progress').textContent = state.error || state.progress || '';
  const active = state.profiles.find((p) => p.id === state.active);
  $('active-status').textContent = active ? `Voix active : ${active.name}` : 'Voix active : voix locale de Windows';
  if (next.readTyped !== undefined) $('read-typed').checked = next.readTyped;
  buttons();
}
function buttons() {
  const profile = state?.profiles.find((p) => p.id === $('profiles').value);
  $('test').disabled = busy || !profile;
  $('activate').disabled = busy || !profile?.testedAt;
  $('delete').disabled = busy || !profile;
  $('create').disabled = busy || Boolean(recording);
}
async function action(fn) {
  if (busy) return; busy = true; buttons();
  try { await fn(); } catch (error) { message(error.message, true); }
  finally { busy = false; buttons(); }
}
function languages() {
  const engine = $('engine').value;
  $('qwen-info').hidden = engine !== 'qwen'; $('gpt-info').hidden = engine === 'qwen';
  const previous = $('language').value || 'fr';
  $('language').replaceChildren(...state.languages[engine].map((lang) => {
    const option = document.createElement('option'); option.value = lang; option.textContent = languageNames[lang]; return option;
  }));
  if (state.languages[engine].includes(previous)) $('language').value = previous;
}
async function normalize(blob) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (decoded.duration < 3 || decoded.duration > 12) throw new Error('Choisis un extrait de 3 à 12 secondes.');
    const offline = new OfflineAudioContext(1, Math.round(decoded.duration * 24000), 24000);
    const mono = offline.createBuffer(1, decoded.length, decoded.sampleRate);
    const samples = mono.getChannelData(0);
    for (let c=0;c<decoded.numberOfChannels;c++) {
      const channel=decoded.getChannelData(c); for(let i=0;i<samples.length;i++) samples[i]+=channel[i]/decoded.numberOfChannels;
    }
    const source=offline.createBufferSource(); source.buffer=mono; source.connect(offline.destination); source.start();
    const rendered=await offline.startRendering(); const pcm=rendered.getChannelData(0);
    const bytes=new Uint8Array(44+pcm.length*2); const view=new DataView(bytes.buffer);
    const text=(at,s)=>{for(let i=0;i<s.length;i++) bytes[at+i]=s.charCodeAt(i);};
    text(0,'RIFF');view.setUint32(4,bytes.length-8,true);text(8,'WAVEfmt ');view.setUint32(16,16,true);
    view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,24000,true);view.setUint32(28,48000,true);
    view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,pcm.length*2,true);
    for(let i=0;i<pcm.length;i++) view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,pcm[i]))*32767),true);
    audioBytes=bytes; if(referenceUrl) URL.revokeObjectURL(referenceUrl);
    referenceUrl=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
    $('reference').src=referenceUrl; $('reference').hidden=false;
    $('audio-status').textContent=`Extrait prêt · ${decoded.duration.toFixed(1)} secondes, conservé sur ce PC.`;
  } finally { await context.close(); }
}
$('engine').addEventListener('change',languages);
$('profiles').addEventListener('change',buttons);
$('prepare').addEventListener('click',()=>action(async()=>{ refresh(result(await api.prepare()));message('Préparation lancée. Le téléchargement peut prendre plusieurs minutes.'); }));
$('gpt-docs').addEventListener('click',()=>api.docs('gpt'));
$('file').addEventListener('change',()=>action(async()=>{
  const file=$('file').files[0]; if(!file)return; if(file.size>20_000_000)throw new Error('Choisis un extrait audio plus petit (20 Mo maximum).');
  await normalize(file); message('Écoute ton extrait, puis renseigne sa transcription exacte.');
}));
$('record').addEventListener('click',async()=>{
  if(recording){recording.stop();return;} if(busy)return;
  try {
    $('preview').pause(); $('reference').pause();
    stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});
    const recorder=new MediaRecorder(stream);recording=recorder;const chunks=[];
    recorder.onerror=()=>{stream?.getTracks().forEach(t=>t.stop());message('L’enregistrement a échoué. Tu peux réessayer ou importer un extrait.',true);if(recorder.state!=='inactive')recorder.stop();};
    recorder.ondataavailable=(e)=>{if(e.data.size)chunks.push(e.data);};
    const timer=setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},10000);
    recorder.onstop=()=>{
      clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());stream=null;recording=null;
      $('record').textContent='Enregistrer au micro';buttons();
      void action(async()=>{await normalize(new Blob(chunks,{type:recorder.mimeType}));message('Extrait enregistré. Écris ce qui a été dit exactement.');});
    };
    recorder.start();$('record').textContent='Terminer l’enregistrement';$('audio-status').textContent='Enregistrement local… parle maintenant (10 secondes maximum).';buttons();
  } catch(error){stream?.getTracks().forEach(t=>t.stop());recording=null;message('Micro indisponible. Vérifie les autorisations Windows ou importe un extrait.',true);buttons();}
});
$('create-form').addEventListener('submit',(event)=>{
  event.preventDefault();void action(async()=>{
    if(!audioBytes)throw new Error('Importe ou enregistre un extrait avant de créer le profil.');
    const value=result(await api.create({name:$('name').value,engine:$('engine').value,language:$('language').value,
      transcript:$('transcript').value,consent:$('consent').checked,audio:audioBytes,port:Number($('port').value)}));
    refresh(value,value.id);message('Profil créé. Écoute un essai avant de l’activer.');
  });
});
$('test').addEventListener('click',()=>action(async()=>{
  message('Création de l’essai sur ce PC… le premier essai peut être plus long.');
  const value=result(await api.test({id:$('profiles').value,text:$('test-text').value}));
  if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(new Blob([value.audio],{type:'audio/wav'}));
  $('preview').src=previewUrl;$('preview').hidden=false;refresh(value);await $('preview').play();message('Essai prêt. Tu peux maintenant utiliser cette voix pour Capri.');
}));
$('stop').addEventListener('click',()=>{$('preview').pause();$('reference').pause();void api.stop();message('Lecture et synthèse arrêtées.');});
$('activate').addEventListener('click',()=>action(async()=>{refresh(result(await api.activate({id:$('profiles').value,readTyped:$('read-typed').checked})));message('Capri utilisera cette voix pour ses prochaines réponses.');}));
$('windows').addEventListener('click',()=>action(async()=>{refresh(result(await api.activate({id:''})));message('La voix Windows est rétablie.');}));
$('delete').addEventListener('click',()=>action(async()=>{refresh(result(await api.remove($('profiles').value)));message('La liste des voix a été actualisée.');}));
window.addEventListener('beforeunload',()=>{stream?.getTracks().forEach(t=>t.stop());});
api.onProgress((value)=>refresh(value));
try { refresh(result(await api.state()));languages(); } catch(error){message(error.message,true);}
