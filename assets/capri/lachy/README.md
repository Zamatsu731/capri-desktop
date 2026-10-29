# Capri sprite animation pack

Required Notice: Copyright 2026 Lachy (https://github.com/lachydotmcg)

Source: https://github.com/lachydotmcg/capri-desktop/tree/0b2dd14cdc2ad617cb5d76a06b764d9aaf72968f/assets/sprites

These 20 PNG strips come from the fixed commit above. The source repository's
PolyForm Noncommercial 1.0.0 license is preserved in LICENSE.md. The character and
original artwork remain the property of their respective rights holders.

Only image data was imported. PNG signatures, dimensions, chunk CRCs, decompressed
lengths and row filters were checked; unrelated metadata was stripped. Source and
packaged SHA-256 hashes are recorded in manifest.json. No upstream C# application,
desktop automation code, installer, binary dependency or update service is included.

The renderer reads these packaged local images using a fixed list of clip names.
It never downloads animation code at runtime. The JavaScript player is implemented
in src/renderer/js/animation-pack.js and follows Capri's reduced-motion setting.
