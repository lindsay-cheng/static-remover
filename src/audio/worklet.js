// AudioWorklet processor. Bundled ESM: imports the exact DSP module the
// offline harness validates (test-dsp.mjs), so browser behavior == tuned
// behavior. One SpectralSubtractor per channel, stereo in/out.
//
// Runs on the audio thread: no allocation in process() or onMessage beyond
// small message objects. All runtime control arrives as port messages and
// lands via scalar setParams() -- the graph is never rebuilt.

import { SpectralSubtractor } from '../dsp/spectral-subtractor.js';

class StaticRemoverProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.frameSize = o.frameSize || 2048;
    this.settings = {
      maxSuppressionDb: o.maxSuppressionDb ?? 15,
      noiseBiasDb: o.noiseBiasDb ?? 9,
    };
    this.enabled = false;
    this.errorSent = false;
    this.channels = [];

    for (let i = 0; i < 2; i++) {
      const s = new SpectralSubtractor({
        sampleRate,
        frameSize: this.frameSize,
        hopSize: this.frameSize / 2,
        maxSuppressionDb: this.settings.maxSuppressionDb,
        noiseBiasDb: this.settings.noiseBiasDb,
      });
      s.setBypassed(true); // start bypassed; no processing until enabled
      this.channels.push(s);
    }

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (!m) return;
    if (m.type === 'enabled') {
      this.enabled = !!m.value;
      if (m.value) this.applyConfig(m);
      for (const s of this.channels) s.setBypassed(!this.enabled);
      return;
    }
    if (m.type === 'config') {
      this.applyConfig(m);
    }
  }

  applyConfig(m) {
    if (Number.isFinite(m.maxSuppressionDb)) this.settings.maxSuppressionDb = m.maxSuppressionDb;
    if (Number.isFinite(m.noiseBiasDb)) this.settings.noiseBiasDb = m.noiseBiasDb;
    for (const s of this.channels) {
      s.setParams({
        maxSuppressionDb: this.settings.maxSuppressionDb,
        noiseBiasDb: this.settings.noiseBiasDb,
      });
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) {
      for (const ch of output) ch.fill(0);
      return true;
    }

    try {
      const n = Math.min(output.length, this.channels.length);
      for (let c = 0; c < n; c++) {
        const inCh = input[c] || input[0];
        this.channels[c].process(inCh, output[c]);
      }
      for (let c = n; c < output.length; c++) {
        output[c].set(input[c] || input[0]);
      }
    } catch (err) {
      // Never let an exception turn into permanent silence.
      for (let c = 0; c < output.length; c++) {
        output[c].set(input[c] || input[0]);
      }
      if (!this.errorSent) {
        this.errorSent = true;
        this.port.postMessage({ type: 'error', message: String(err) });
      }
    }
    return true;
  }
}

registerProcessor('static-remover', StaticRemoverProcessor);
