# Local voice runtime

Qwen3-TTS package 0.1.1 (wheel SHA-256 pinned in prepare.py), official Apache-2.0
model Qwen/Qwen3-TTS-12Hz-0.6B-Base at revision
5d83992436eae1d760afd27aff78a71d676296fc. Sources:
https://github.com/QwenLM/Qwen3-TTS and
https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base

No Gradio WebUI is installed or started. The worker communicates over private stdio,
uses an isolated Python environment, runs with Hugging Face offline mode, and accepts
only bounded PCM reference files selected through internal profile UUIDs and text.
Every model/config/tokenizer file is checked against the bundled SHA-256 manifest
before loading. Unexpected model files are rejected. No pickle checkpoint imports,
remote model code, training scripts or arbitrary model paths are exposed by the UI.

Security review 2026-10-28: setuptools updated to 84.2.1. OSV also reports advisories
in the upstream-compatible torch 2.10.0, transformers 4.57.3 and accelerate 1.12.0.
These concern torch.jit.script, other model initialization/training/save paths,
custom generation code downloads and sharded checkpoint index traversal. The studio
does not expose those inputs or operations; the fixed unsharded Safetensors model
is verified and loaded offline. These restrictions are mitigations, not patches to
the dependencies, and this runtime must not be described as vulnerability-free.
Replacing dependencies across major versions requires Qwen compatibility testing.

GPT-SoVITS is optional and separately managed by the user. The adapter only POSTs
to /tts on 127.0.0.1, validates the port, rejects redirects, and bounds WAV responses.
It never invokes control or weight-loading endpoints. Safety of a separately
installed GPT-SoVITS server or its models is outside this verification.
