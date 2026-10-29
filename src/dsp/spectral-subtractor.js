// MMSE-STSA suppression (Ephraim-Malah) with decision-directed a priori SNR.
// The DD recursion is the temporal smoother; there is deliberately NO
// gain-domain smoothing (it costs 0.5-1.5 dB per partial and smears piano
// attacks). Raw spectral subtraction was replaced after round-1 listening
// found it muffled/underwater: its hard gate deleted everything at 4-12 dB
// local SNR (accompaniment, reverb tails). A bypass flag forces unity gain
// on all bins (bit-exact delay line, same latency) for toggle-off.
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
      maxSuppressionDb = 15,
      noiseBiasDb = 9,
      noiseRiseSec = 8,
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
    this.gain = new Float32Array(this.bins);
    this.pSmooth = new Float32Array(this.bins);
    this.cleanPow = new Float32Array(this.bins);
    this.gain.fill(1);
    this.bypass = false;

    // Output FIFO, preloaded with N zeros (= the latency).
    this.fifoCapacity = 8 * this.N;
    this.fifo = new Float32Array(this.fifoCapacity);
    this.fifoHead = 0;
    this.fifoCount = this.N;
  }

  // Scalar-only runtime update for the options page path. Clamps instead of
  // throwing (the audio thread must never die on untrusted input) and
  // allocates nothing, so it is safe to call from a worklet message handler.
  // Unknown keys (e.g. the retired alpha) are ignored.
  setParams(params = {}) {
    if (params.maxSuppressionDb !== undefined && Number.isFinite(params.maxSuppressionDb)) {
      const db = Math.max(0, Math.min(40, params.maxSuppressionDb));
      this.gFloor = Math.pow(10, -db / 20);
    }
    if (params.noiseBiasDb !== undefined && Number.isFinite(params.noiseBiasDb)) {
      const db = Math.max(0, Math.min(20, params.noiseBiasDb));
      this.noiseBias = Math.pow(10, db / 20);
    }
  }

  // Toggle-off path: unity gain on every bin, estimator keeps running warm,
  // delay unchanged. Bit-exact (verified in test-dsp.mjs).
  setBypassed(bypassed) {
    this.bypass = !!bypassed;
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
      pSmooth, cleanPow,
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
      pSmooth[k] = 0.5 * pSmooth[k] + 0.5 * p; // 2-frame periodogram average
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

    // Gains: MMSE-STSA (Ephraim-Malah 1984, eq. 13) with decision-directed
    // a priori SNR (eq. 51, alpha 0.98). The DD recursion is the temporal
    // smoother, so there is no gain-domain smoothing at all. Bypass forces
    // unity gain (bit-exact delay line, same latency) for toggle-off.
    const gFloor = this.gFloor;
    const gain = this.gain;
    const bypass = this.bypass;
    const DD_ALPHA = 0.98;
    const XI_MIN = 0.0031622776601683794; // -25 dB
    const XI_MAX = 1000;

    for (let k = 0; k <= this.maxBin; k++) {
      if (bypass) {
        gain[k] = 1;
        cleanPow[k] = power[k];
        continue;
      }
      const n = noise[k] + 1e-20;

      let gamma = pSmooth[k] / n;
      if (gamma < 1e-6) gamma = 1e-6;
      else if (gamma > 1e4) gamma = 1e4;

      let xi = DD_ALPHA * (cleanPow[k] / n) + (1 - DD_ALPHA) * (gamma > 1 ? gamma - 1 : 0);
      if (xi < XI_MIN) xi = XI_MIN;
      else if (xi > XI_MAX) xi = XI_MAX;

      gain[k] = stsGain(xi, gamma, gFloor);
      cleanPow[k] = gain[k] * gain[k] * power[k];
    }
    gain[0] = 1;
    for (let k = this.maxBin + 1; k < bins; k++) {
      gain[k] = 1;
      cleanPow[k] = power[k];
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

// Modified Bessel functions of the first kind, Abramowitz & Stegun 9.8.1 /
// 9.8.2. |error| < 1.6e-7, ~12 flops each, no tables, no allocation.
export function besselI0(x) {
  const ax = Math.abs(x);
  if (ax < 3.75) {
    const t = (x / 3.75) * (x / 3.75);
    return (
      1 +
      t *
        (3.5156229 +
          t *
            (3.0899424 +
              t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813)))))
    );
  }
  const y = 3.75 / ax;
  return (
    (Math.exp(ax) / Math.sqrt(ax)) *
    (0.39894228 +
      y *
        (0.01328592 +
          y *
            (0.00225319 +
              y *
                (-0.00157565 +
                  y *
                    (0.00916281 +
                      y * (-0.02057706 + y * (0.02635537 + y * (-0.01647633 + y * 0.00392377))))))))
  );
}

export function besselI1(x) {
  const ax = Math.abs(x);
  let r;
  if (ax < 3.75) {
    const t = (x / 3.75) * (x / 3.75);
    r =
      x *
      (0.5 +
        t *
          (0.87890594 +
            t * (0.51498869 + t * (0.15084934 + t * (0.02658733 + t * (0.00301532 + t * 0.00032411))))));
  } else {
    const y = 3.75 / ax;
    r =
      (Math.exp(ax) / Math.sqrt(ax)) *
      (0.39894228 +
        y *
          (-0.03988024 +
            y *
              (-0.00362018 +
                y *
                  (0.00163801 +
                    y * (-0.01031555 + y * (0.02282967 + y * (-0.02895312 + y * (0.01787654 - y * 0.00420059))))))));
  }
  return x < 0 ? -r : r;
}

// MMSE-STSA gain (Ephraim-Malah 1984, eq. 13) for a priori SNR xi and
// a posteriori SNR gamma, clamped to [gFloor, 1]. nu > 50 uses the Wiener
// asymptote (exact to 0.043 dB, avoids exp overflow).
export function stsGain(xi, gamma, gFloor = 0) {
  const nu = (xi * gamma) / (1 + xi);
  let g;
  if (nu > 50) {
    g = xi / (1 + xi);
  } else {
    const h = 0.5 * nu;
    g =
      ((0.8862269254527580 * Math.sqrt(nu)) / gamma) *
      Math.exp(-h) *
      ((1 + nu) * besselI0(h) + nu * besselI1(h));
  }
  if (g < gFloor) g = gFloor;
  else if (g > 1) g = 1;
  return g;
}
