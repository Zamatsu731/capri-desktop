# Security notes

This source folder contains no personal voice, API key, local configuration, model
weights or executable installer. Keep those files out of Git; `.gitignore` includes
the common private/runtime paths. Store API keys through the application's settings.

The Electron interface uses isolated, sandboxed renderers, a local content policy
and scoped IPC. Imported sprite strips are local PNGs from the fixed upstream
revision documented in `assets/capri/lachy/README.md`, with their license and hashes.

Run `npm audit` and the tests before a release. Dependencies can acquire new
advisories after this folder was prepared. No antivirus or test can guarantee that
an application is free of vulnerabilities.

The optional French voice engine is not installed by `npm ci` or bundled in this
repository. It uses a separate Python environment and pinned, hash-verified model.
Its upstream-compatible torch, transformers and accelerate versions have known
advisories; input restrictions mitigate exposure but do not patch the dependencies.
See `scripts/voice/README.md` before enabling it. A separately installed GPT-SoVITS
server and its third-party models are outside this review.

Do not post API keys, voice samples, private logs or configuration files in public
issues. Redact personal paths and account details from diagnostic reports.
