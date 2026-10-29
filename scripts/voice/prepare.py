"""Prepare an isolated local voice runtime. No system Python packages are changed."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import venv
os.environ['PYTHONUTF8'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

MODEL = 'Qwen/Qwen3-TTS-12Hz-0.6B-Base'
REVISION = '5d83992436eae1d760afd27aff78a71d676296fc'
QWEN_WHEEL = 'https://files.pythonhosted.org/packages/31/01/95f3ae26f5b7eb2105f69ad2c15af5a28b9ebdd1258a0b27541f5ebd6225/qwen_tts-0.1.1-py3-none-any.whl'
QWEN_SHA256 = '11a290d8dabc7ef91a90c54478c8ab19b3edb1d85c0882313721892bdc4af15d'

def progress(message):
    print(json.dumps({'progress': str(message)[:400]}, ensure_ascii=True), flush=True)

def run(args):
    args = [args[0], '-I', '-X', 'utf8', *args[1:]]
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, encoding='utf-8', errors='replace',
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    for line in process.stdout:
        if line.strip():
            progress(line.strip())
    if process.wait():
        raise RuntimeError('Une étape de préparation a échoué. Le journal indique laquelle.')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--download-model', action='store_true')
    args = parser.parse_args()
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    (root / 'ready.json').unlink(missing_ok=True)
    python = root / 'env' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not python.is_file():
        progress('Création de l’environnement Python isolé…')
        venv.EnvBuilder(with_pip=True).create(root / 'env')
    progress('Installation du moteur vocal local et de ses bibliothèques…')
    run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
         'torch==2.10.0', 'torchaudio==2.10.0', '--index-url', 'https://download.pytorch.org/whl/cu128'])
    run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
         '-r', str(Path(__file__).parent / 'requirements-lock.txt')])
    wheel = root / 'qwen_tts-0.1.1-py3-none-any.whl'
    if not wheel.is_file() or hashlib.sha256(wheel.read_bytes()).hexdigest() != QWEN_SHA256:
        with urllib.request.urlopen(QWEN_WHEEL, timeout=60) as response:
            data = response.read(2_000_000)
        if hashlib.sha256(data).hexdigest() != QWEN_SHA256:
            raise RuntimeError('Empreinte du moteur Qwen incorrecte.')
        wheel.write_bytes(data)
    run([str(python), '-m', 'pip', 'install', '--no-deps', '--disable-pip-version-check', str(wheel)])
    progress('Téléchargement du modèle français (une seule fois)…')
    code = ('from huggingface_hub import snapshot_download; '
            f'snapshot_download({MODEL!r}, revision={REVISION!r}, local_dir={str(root / "model")!r}, '
            'allow_patterns=["*.json", "*.safetensors", "*.txt"])')
    run([str(python), '-c', code])
    progress('Vérification de l’intégrité du modèle officiel…')
    manifest = json.loads((Path(__file__).parent / 'model-sha256.json').read_text(encoding='utf-8'))
    for relative, expected in manifest.items():
        file = root / 'model' / relative
        with file.open('rb') as data:
            actual = hashlib.file_digest(data, 'sha256').hexdigest()
        if actual != expected:
            raise RuntimeError('Le modèle téléchargé ne correspond pas au modèle officiel vérifié.')
    run([str(python), '-c', 'import torch; from qwen_tts import Qwen3TTSModel; '
         'print("GPU disponible:", torch.cuda.is_available())'])
    (root / 'ready.json').write_text(json.dumps({'model': MODEL, 'revision': REVISION,
        'qwen_tts': '0.1.1', 'python': str(python)}, indent=2), encoding='utf-8')
    progress('Le moteur français est prêt.')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=True), flush=True)
        sys.exit(1)
