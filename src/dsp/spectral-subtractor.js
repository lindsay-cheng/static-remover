// Spectral subtraction with adaptive noise estimation. Music-safe: no ML, no
// speech model, no user-picked profile. Tuned against the Rach 3 samples in
// ../../samples. Plain JS, zero allocations after construction, so the same
// file runs inside an AudioWorklet and inside the Node harness.
//
// Noise estimation, two ingredients:
//
// 1. Asymmetric envelope tracker. Per bin, the estimate follows the smoothed
//    power spectrum's lower envelope: falling fast (tracks the floor dropping,
//    e.g. the loud first 15 s of the Rach 3 upload) and rising slowly
//    (~noiseRiseSec time constant, so loud transients and musical notes can
//    never slam it up).
//
// 2. Tonality gate. A purely statistical estimator cannot tell a sustained
//    tone from noise -- a held note eventually gets absorbed and crushed.
//    The discriminator is phase coherence: a tone's STFT phase advances by
//    the same amount every frame, noise's phase is random. Bins that look
//    tonal freeze their noise estimate entirely, so musical notes, held or
//    decaying, are never mistaken for the floor.
//
// Estimation starts after a short warmup (coherence needs a few frames to
// become meaningful), and silence frames freeze it so pause/mute is safe.
//
// Streaming contract: process(input, output) with input.length === output.length.
// output[i] is the cleaned version of input[i - frameSize] (latency = frameSize
// samples; ~43 ms at 48 kHz, inside the plan's <50 ms budget). The first
// frameSize output samples are zero (pipeline fill).

import { FFT } from './fft.js';

const TWO_PI = 2 * Math.PI;

export class SpectralSubtractor {
  constructor(options = {}) {
    const {
      sampleRate = 48000,
      frameSize = 2048,
      hopSize = 1024,
      alpha = 1.0,
      maxSuppressionDb = 12,
      noiseBiasDb = 3,
      noiseRiseSec = 60,
      warmupSec = 0.5,
      smoothBeta = 0.75,
      maxProcessHz = 16000,
      tonalityGate = 0.5,
      coherenceLambda = 0.9,
    } = options;

    if (hopSize !== frameSize / 2) {
      throw new Error('this build requires hopSize = frameSize / 2 (50% overlap)');
    }

    this.sampleRate = sampleRate;
    this.N = frameSize;
    this.H = hopSize;
    this.bins = (frameSize >> 1) + 1;

    this.alpha = alpha;
    this.gFloor = Math.pow(10, -maxSuppressionDb / 20);
    this.noiseBias = Math.pow(10, noiseBiasDb / 20);
    this.beta = smoothBeta;
    this.oneMinusBeta = 1 - smoothBeta;
    this.maxBin = Math.min(this.bins - 1, Math.round((maxProcessHz * frameSize) / sampleRate));
    this.tonalityGate = tonalityGate;
    this.lambda = coherenceLambda;
    this.oneMinusLambda = 1 - coherenceLambda;

    // Estimator dynamics: fast fall toward lower-envelope dips, slow rise
    // (time constant noiseRiseSec seconds).
    const framesPerSec = sampleRate / hopSize;
    this.estFall = 0.1;
    this.estRise = 1 / (noiseRiseSec * framesPerSec);
    this.warmupFrames = Math.round(warmupSec * framesPerSec);
    this.framesSeen = 0;

    this.fft = new FFT(frameSize);

    // sqrt-Hann analysis + synthesis windows: their product is Hann, which is
    // COLA at 50% overlap (sums to 1), so gain=1 reconstructs perfectly.
    this.window = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      this.window[i] = Math.sqrt(0.5 - 0.5 * Math.cos((TWO_PI * i) / this.N));
    }

    // Streaming state.
    this.frameBuf = new Float32Array(this.N);
    this.frameFill = 0;
    this.frameRe = new Float32Array(this.N);
    this.frameIm = new Float32Array(this.N);
    this.ola = new Float32Array(this.N);
    this.norm = new Float32Array(this.N);

    // Per-bin spectrum state.
    this.power = new Float32Array(this.bins);
    this.smoothed = new Float32Array(this.bins);
    this.est = new Float32Array(this.bins);
    this.noise = new Float32Array(this.bins);
    this.prevRe = new Float32Array(this.bins);
    this.prevIm = new Float32Array(this.bins);
    this.crossRe = new Float32Array(this.bins);
    this.crossIm = new Float32Array(this.bins);
    this.magProd = new Float32Array(this.bins);
    this.coherence = new Float32Array(this.bins);
    this.prevGain = new Float32Array(this.bins);
    this.gainTmp = new Float32Array(this.bins);
    this.gain = new Float32Array(this.bins);
    this.prevGain.fill(1);
    this.gain.fill(1);

    // Output FIFO, preloaded with N zeros (= the latency).
    this.fifoCapacity = 8 * this.N;
    this.fifo = new Float32Array(this.fifoCapacity);
    this.fifoHead = 0;
    this.fifoCount = this.N;
  }

  // Scalar-only runtime update for the options page path. Clamps instead of
  // throwing (the audio thread must never die on untrusted input) and
  // allocates nothing, so it is safe to call from a worklet message handler.
  setParams(params = {}) {
    if (params.alpha !== undefined && Number.isFinite(params.alpha)) {
      this.alpha = Math.max(0, Math.min(8, params.alpha));
    }
    if (params.maxSuppressionDb !== undefined && Number.isFinite(params.maxSuppressionDb)) {
      const db = Math.max(0, Math.min(40, params.maxSuppressionDb));
      this.gFloor = Math.pow(10, -db / 20);
    }
    if (params.noiseBiasDb !== undefined && Number.isFinite(params.noiseBiasDb)) {
      const db = Math.max(0, Math.min(20, params.noiseBiasDb));
      this.noiseBias = Math.pow(10, db / 20);
    }
  }

  process(input, output) {    const len = input.length;
    if (output.length !== len) {
      throw new Error('input and output must have the same length');
    }
    for (let i = 0; i < len; i++) {
      this.frameBuf[this.frameFill++] = input[i];
      if (this.frameFill === this.N) {
        this.processFrame();
      }
      output[i] = this.pop();
    }
  }

  processFrame() {
    const {
      N, H, bins, window, frameRe, frameIm, smoothed, power,
      est, noise, prevRe, prevIm, crossRe, crossIm, magProd, coherence,
    } = this;

    // Windowed analysis frame.
    for (let i = 0; i < N; i++) {
      frameRe[i] = this.frameBuf[i] * window[i];
      frameIm[i] = 0;
    }
    this.fft.forward(frameRe, frameIm);

    // Power spectrum, smoothed spectrum, and frame-to-frame phase coherence.
    // Coherence ~1 => tonal (a tone's phase advances constantly), ~0 => noise.
    const lambda = this.lambda;
    const oneMinusLambda = this.oneMinusLambda;
    let totalPower = 0;
    for (let k = 0; k < bins; k++) {
      const xr = frameRe[k];
      const xi = frameIm[k];
      const p = xr * xr + xi * xi;
      power[k] = p;
      totalPower += p;
      smoothed[k] = this.beta * smoothed[k] + this.oneMinusBeta * p;

      const pr = xr * prevRe[k] + xi * prevIm[k];
      const pi = xi * prevRe[k] - xr * prevIm[k];
      prevRe[k] = xr;
      prevIm[k] = xi;
      crossRe[k] = lambda * crossRe[k] + oneMinusLambda * pr;
      crossIm[k] = lambda * crossIm[k] + oneMinusLambda * pi;
      const prod = Math.sqrt(pr * pr + pi * pi);
      magProd[k] = lambda * magProd[k] + oneMinusLambda * prod;
      coherence[k] = Math.sqrt(crossRe[k] * crossRe[k] + crossIm[k] * crossIm[k]) / (magProd[k] + 1e-20);
    }

    // Noise floor = lower envelope of the smoothed spectrum, biased up to the
    // mean noise level. Tonal bins and silence frames freeze the estimate so
    // notes and pause/mute are never absorbed.
    if (totalPower > 1e-8) {
      if (this.framesSeen >= this.warmupFrames) {
        const fall = this.estFall;
        const rise = this.estRise;
        const bias = this.noiseBias;
        const gate = this.tonalityGate;
        for (let k = 0; k < bins; k++) {
          if (coherence[k] < gate) {
            const s = smoothed[k];
            const e = est[k];
            est[k] = e === 0 ? s : e + (s - e) * (s < e ? fall : rise);
            noise[k] = est[k] * bias;
          }
        }
      }
      this.framesSeen++;
    }

    // Gains: G = clamp(1 - alpha * N / |X|^2), then temporal and frequency
    // smoothing to keep residuals from turning into musical noise.
    const gFloor = this.gFloor;
    const alpha = this.alpha;
    const gainTmp = this.gainTmp;
    const prevGain = this.prevGain;
    const gain = this.gain;

    for (let k = 0; k <= this.maxBin; k++) {
      const n = noise[k];
      let g = 1 - (alpha * n) / (power[k] + 1e-20);
      if (g < gFloor) g = gFloor;
      else if (g > 1) g = 1;
      const prev = prevGain[k];
      // Fast when suppression deepens, moderate when releasing.
      const smoothedG = prev + (g - prev) * (g < prev ? 0.35 : 0.5);
      prevGain[k] = smoothedG;
      gainTmp[k] = smoothedG;
    }
    for (let k = this.maxBin + 1; k < bins; k++) {
      prevGain[k] = 1;
      gainTmp[k] = 1;
    }

    gain[0] = gainTmp[0];
    gain[bins - 1] = gainTmp[bins - 1];
    for (let k = 1; k < bins - 1; k++) {
      gain[k] = 0.25 * gainTmp[k - 1] + 0.5 * gainTmp[k] + 0.25 * gainTmp[k + 1];
    }

    // Apply gains; mirror onto the negative-frequency bins.
    for (let k = 0; k <= this.maxBin; k++) {
      const g = gain[k];
      frameRe[k] *= g;
      frameIm[k] *= g;
      if (k > 0 && k < N - k) {
        frameRe[N - k] *= g;
        frameIm[N - k] *= g;
      }
    }

    // Synthesis: windowed OLA with running norm so reconstruction is exact
    // (gain = 1 case) even across the stream-start ramp.
    this.fft.inverse(frameRe, frameIm);
    const ola = this.ola;
    const norm = this.norm;
    for (let i = 0; i < N; i++) {
      const w = window[i];
      ola[i] += frameRe[i] * w;
      norm[i] += w * w;
    }

    // The first H samples of the OLA buffer are complete; emit and shift.
    for (let i = 0; i < H; i++) {
      const nz = norm[i];
      this.push(nz > 0.125 ? ola[i] / nz : 0);
    }
    ola.copyWithin(0, H);
    ola.fill(0, N - H);
    norm.copyWithin(0, H);
    norm.fill(0, N - H);

    // Next frame starts from the second half of the current input window.
    this.frameBuf.copyWithin(0, H);
    this.frameFill = N - H;
  }

  push(v) {
    if (this.fifoCount === this.fifoCapacity) {
      throw new Error('output FIFO overflow');
    }
    this.fifo[(this.fifoHead + this.fifoCount) % this.fifoCapacity] = v;
    this.fifoCount++;
  }

  pop() {
    if (this.fifoCount === 0) {
      throw new Error('output FIFO underflow');
    }
    const v = this.fifo[this.fifoHead];
    this.fifoHead = (this.fifoHead + 1) % this.fifoCapacity;
    this.fifoCount--;
    return v;
  }
}
