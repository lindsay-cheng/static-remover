# static-remover

Real-time static/noise removal for YouTube audio, as a Chrome MV3 extension.
One toolbar click cleans a noisy recording; off until toggled, per tab.

- `src/dsp/` — the denoiser core. Plain JS, no browser or Node APIs. Shared
  verbatim by the extension's AudioWorklet and the offline harness.
- `harness/` — runs the core over WAV files (slice 1 tuning loop).
- The extension itself (manifest, content script, options page) lands in slice 2.

Run the tuning harness:

    bash harness/run-samples.sh
