"""Private stdio-only French-capable TTS worker; no HTTP listener or remote audio inputs."""
import argparse
import base64
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
LANGUAGES = {'fr': 'French', 'en': 'English', 'es': 'Spanish', 'pt': 'Portuguese', 'ru': 'Russian',
             'de': 'German', 'it': 'Italian', 'zh': 'Chinese', 'ja': 'Japanese', 'ko': 'Korean'}

def send(message):
    print(json.dumps(message, ensure_ascii=True), flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--references', required=True)
    parser.add_argument('--cpu', action='store_true')
    args = parser.parse_args()
    references = Path(args.references).resolve()
    model_path = Path(args.model).resolve()
    manifest = json.loads((Path(__file__).parent / 'model-sha256.json').read_text(encoding='utf-8'))
    for relative, expected in manifest.items():
        with (model_path / relative).open('rb') as data:
            if hashlib.file_digest(data, 'sha256').hexdigest() != expected:
                raise ValueError('Modèle modifié : relance la préparation du moteur.')
    # Only the pinned, unsharded Safetensors models are accepted. No custom code/checkpoint inputs.
    allowed = set(manifest)
    for file in model_path.rglob('*'):
        if file.is_file() and '.cache' not in file.relative_to(model_path).parts and file.relative_to(model_path).as_posix() not in allowed:
            raise ValueError('Fichier inattendu dans le modèle vocal.')
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel
        torch.set_num_threads(min(6, os.cpu_count() or 2))
        modern_gpu = torch.cuda.is_available() and torch.cuda.get_device_capability()[0] >= 8
        minimum = (3.5 if modern_gpu else 4.8) * 1024**3
        gpu = not args.cpu and torch.cuda.is_available() and torch.cuda.mem_get_info()[0] > minimum
        device = 'cuda:0' if gpu else 'cpu'
        model = Qwen3TTSModel.from_pretrained(str(Path(args.model).resolve()),
            device_map=device, dtype=torch.bfloat16 if gpu and modern_gpu else torch.float32,
            attn_implementation='eager', local_files_only=True,
            trust_remote_code=False, use_safetensors=True)
    send({'kind': 'ready', 'device': device})
    prompts = {}
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 12000:
                raise ValueError('Requête trop longue.')
            request = json.loads(line)
            profile = request.get('profile', '')
            text = request.get('text', '')
            transcript = request.get('transcript', '')
            language = request.get('language')
            if not isinstance(profile, str) or not re.fullmatch(r'[a-f0-9-]{36}', profile):
                raise ValueError('Profil invalide.')
            if language not in LANGUAGES or not isinstance(text, str) or not 1 <= len(text) <= 600:
                raise ValueError('Texte ou langue invalide.')
            if not isinstance(transcript, str) or not 1 <= len(transcript) <= 600:
                raise ValueError('La transcription de référence est requise.')
            reference = (references / (profile + '.wav')).resolve()
            if reference.parent != references or not reference.is_file():
                raise ValueError('Extrait de référence introuvable.')
            with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
                if profile not in prompts:
                    if len(prompts) >= 4:
                        prompts.clear()
                    prompts[profile] = model.create_voice_clone_prompt(ref_audio=str(reference),
                        ref_text=transcript, x_vector_only_mode=False)
                waves, rate = model.generate_voice_clone(text=text, language=LANGUAGES[language],
                    voice_clone_prompt=prompts[profile], max_new_tokens=1024)
                audio = np.asarray(waves[0], dtype=np.float32)
                if audio.ndim != 1 or not np.isfinite(audio).all() or len(audio) > rate * 120:
                    raise ValueError('Audio généré invalide ou trop long.')
                output = io.BytesIO()
                sf.write(output, audio, rate, format='WAV', subtype='PCM_16')
            send({'kind': 'result', 'id': request.get('id'),
                  'audio': base64.b64encode(output.getvalue()).decode('ascii')})
        except Exception as error:
            cuda = 'cuda' in str(error).lower() or 'probability tensor' in str(error).lower()
            send({'kind': 'error', 'id': request.get('id'), 'error': str(error)[:500], 'code': 'cuda' if cuda else 'generation'})
            if cuda:
                break

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        send({'kind': 'fatal', 'error': str(error)[:500]})
        sys.exit(1)
