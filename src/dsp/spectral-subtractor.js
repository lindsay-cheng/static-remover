// MMSE-STSA suppression (Ephraim-Malah) with decision-directed a priori SNR.
// The DD recursion is the temporal smoother; there is deliberately NO
// gain-domain smoothing (it costs 0.5-1.5 dB per partial and smears piano
// attacks). Raw spectral subtraction was replaced after round-1 listening
// found it muffled/underwater: its hard gate deleted everything at 4-12 dB
// local SNR (accompaniment, reverb tails). A bypass flag forces unity gain
// on all bins (bit-exact delay line, same latency) for toggle-off.
//
// Noise estimation: asymmetric envelope of the smoothed spectrum (instant
// fall to dips, slow rise) with tonal bins rejecting observations (phase
// coherence: tones advance identically every frame, noise does not), plus
// a tripwire forcing updates on persistent divergence. A slow global-minimum
// anchor pins runaway estimates near the true floor remembered from quieter
// moments (minute-scale creep, so loud stretches barely move it).
// Suppression is governed per bin by calm-ease: consecutive calm frames
// (power near its average = sustained content) progressively spare the bin;
// fluctuation earns full cleaning.
//
// Gated estimation starts after ~2 s; before that the output passes
// through. Silence freezes estimation (pause/mute safe).
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
      noiseBiasDb = 6,
      noiseRiseSec = 8,
      slowRiseSec = 600,
      slowMargin = 1.5,
      transientRatio = 3,
      initSec = 2.0,
      smoothBeta = 0.75,
      maxProcessHz = 16000,
      tonalityGate = 0.8,
      coherenceLambda = 0.9,
      tripRatio = 4,
      tripFrames = 25,
    } = options;

    if (hopSize !== frameSize / 2) {
      throw new Error('this build requires hopSize = frameSize / 2 (50% overlap)');
    }

    this.sampleRate = sampleRate;
    this.N = frameSize;
    this.H = hopSize;
    this.bins = (frameSize >> 1) + 1;

    this.gFloor = Math.pow(10, -maxSuppressionDb / 20);
    this.maxSuppressionDb = maxSuppressionDb;
    this.maxBin = Math.min(this.bins - 1, Math.round((maxProcessHz * frameSize) / sampleRate));
    // Subband edges for per-band trust (<500 Hz / 500 Hz-4 kHz / >4 kHz).
    // NOTE: maxBin must be set first (it bounds the edges).
    this.loK = Math.min(this.maxBin, Math.ceil((500 * frameSize) / sampleRate));
    this.midK = Math.min(this.maxBin, Math.ceil((4000 * frameSize) / sampleRate));
    this.noiseBias = Math.pow(10, noiseBiasDb / 20);
    this.beta = smoothBeta;
    this.oneMinusBeta = 1 - smoothBeta;
    this.maxBin = Math.min(this.bins - 1, Math.round((maxProcessHz * frameSize) / sampleRate));
    this.tonalityGate = tonalityGate;
    this.tripRatio = tripRatio;
    this.tripFrames = tripFrames;
    this.lambda = coherenceLambda;
    this.oneMinusLambda = 1 - coherenceLambda;

    // Estimator dynamics: fast fall toward lower-envelope dips, slow rise
    // (time constant noiseRiseSec seconds).
    const framesPerSec = sampleRate / hopSize;
    this.estFall = 0.1;
    this.estRise = 1 / (noiseRiseSec * framesPerSec);
    // Slow anchor: doubling per slowRiseSec (minute-scale), so extended
    // loud stretches can only drag the floor memory up ~1-2 dB.
    this.slowCreep = Math.pow(2, 1 / (slowRiseSec * framesPerSec));
    this.slowMargin = slowMargin;
    this.transientRatio = transientRatio;
    // Gated estimation starts after ~2 s of floor evidence; before that the
    // output passes through (a brief fade-in, and the only honest answer
    // before floor evidence exists).
    this.initFrames = Math.round(initSec * framesPerSec);
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
    this.updateFlag = new Uint8Array(this.bins);
    this.tripCount = new Uint16Array(this.bins);
    this.starve = new Uint16Array(this.bins);
    this.initDone = false;

    // Per-bin spectrum state.
    this.power = new Float32Array(this.bins);
    this.smoothed = new Float32Array(this.bins);
    this.est = new Float32Array(this.bins);
    this.slowMin = new Float32Array(this.bins);
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
      est, slowMin, noise, prevRe, prevIm, crossRe, crossIm, magProd, coherence,
      pSmooth, cleanPow, tripCount, starve,
    } = this;

    // Windowed analysis frame.
    for (let i = 0; i < N; i++) {
      frameRe[i] = this.frameBuf[i] * window[i];
      frameIm[i] = 0;
    }
    this.fft.forward(frameRe, frameIm);

    // Power spectrum, smoothed spectrum, and frame-to-frame phase coherence.
    // Coherence ~1 => tonal (a tone's phase advances constantly), ~0 => noise.
    // CUTOFF SNAP: histories (coherence averages, DD clean power) are trailed
    // by loud past energy -- after a 12 dB+ single-frame drop they would
    // claim "tone" for seconds (measured: stuck gains for 4+ s after a
    // cutoff). A sharp drop means the past no longer describes the present,
    // so restart all history from current evidence. Gradual decays (piano
    // dampers, hall tails) never drop this fast and are unaffected.
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

      if (p < smoothed[k] * 0.0625 && smoothed[k] > 1e-8) {
        // Restart HISTORY from current evidence (coherence averages, DD
        // clean power, tripwire) so stale loud past stops claiming "tone".
        // Deliberately does NOT touch est/slowMin/noise: floor estimation
        // stays with the gated updates (seeding them here with single-frame
        // dip outliers poisons slowMin for minutes -- measured: cut collapsed
        // from -15 dB to -2 dB). With coherence reset to 0 the gate opens on
        // the next frame and normal updates reconverge within ~0.5 s.
        crossRe[k] = 0;
        crossIm[k] = 0;
        magProd[k] = 0;
        prevRe[k] = xr;
        prevIm[k] = xi;
        coherence[k] = 0;
        cleanPow[k] = p;
        tripCount[k] = 0;
        continue;
      }

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

    // Floor estimation, two trackers with separate jobs:
    //
    // slowMin: free-running observation minima (gate-independent) = the
    // floor's long memory. Falls instantly to dips, creeps up glacially
    // (minute-scale), drifts down under starvation (no SUBSTANTIAL dip --
    // 6 dB+ below the anchor -- for ~10 s means the anchor is stale loud
    // memory, e.g. soft music after a loud stretch with no gaps; small
    // breathing fluctuations must not reset the clock). Under-suppression
    // is the safe direction throughout.
    //
    // est/noise: gated tracker (coherence rejects tonal observations) plus
    // tripwire, seeded once from slowMin. Tonal bins REJECT observations
    // (a sustained tone must never become the "floor"). Tripwire: DIVERGENT
    // frames accumulate (4x either way) and force an update at 25, however
    // intermittent the gate flicker is; agreement resets the count, so
    // steady tones never trip. Gate at 0.8, above overlapped-noise readings
    // (50% frame overlap inflates noise coherence to ~0.4-0.77; tones read
    // 0.95+). Silence frames freeze everything so pause/mute is safe.
    if (totalPower > 1e-8) {
      if (this.framesSeen >= this.initFrames) {
        const bias = this.noiseBias;
        if (!this.initDone) {
          for (let k = 0; k < bins; k++) {
            est[k] = smoothed[k];
            slowMin[k] = smoothed[k];
            noise[k] = smoothed[k] * bias;
          }
          this.initDone = true;
        }
        const fall = this.estFall;
        const rise = this.estRise;
        const slowCreep = this.slowCreep;
        const slowMargin = this.slowMargin;
        const gate = this.tonalityGate;
        const tripRatio = this.tripRatio;
        const tripFrames = this.tripFrames;
        const updateFlag = this.updateFlag;
        for (let k = 0; k < bins; k++) {
          const s = smoothed[k];
          const e = est[k];
          if (e !== 0 && s <= e * tripRatio && s * tripRatio >= e) {
            // Estimate agrees with observation: rejection (if any) is
            // correct, clear any accumulated trip.
            tripCount[k] = 0;
            updateFlag[k] = coherence[k] < gate ? 1 : 0;
            continue;
          }
          // Divergent: open gate updates (converging); closed gate counts
          // toward a forced update. Opens never reset the count, so gate
          // flap cannot starve convergence.
          if (coherence[k] < gate) {
            updateFlag[k] = 1;
            continue;
          }
          if (++tripCount[k] >= tripFrames) {
            updateFlag[k] = 1;
            tripCount[k] = 0;
          } else {
            updateFlag[k] = 0;
          }
          // Starvation clock for global ease (below): consecutive frames
          // without a substantial dip (6 dB+ below est). Fluctuating audio
          // resets constantly; sustained content accumulates. Uint16 caps
          // the count (no wrap blips).
          const p = power[k];
          if (p > s * 0.5 && p < s * 2) {
            if (starve[k] < 60000) starve[k]++;
          } else {
            starve[k] = 0;
          }
        }
        for (let k = 0; k < bins; k++) {
          if (!updateFlag[k]) continue;
          const s = smoothed[k];
          const e = est[k];
          est[k] = e === 0 ? s : e + (s - e) * (s < e ? fall : rise);
          const m = slowMin[k];
          if (m === 0) {
            slowMin[k] = s;
          } else if (s < m) {
            slowMin[k] = s;
          } else {
            slowMin[k] = m * slowCreep;
          }
          const anchored = slowMin[k] * slowMargin;
          noise[k] = (est[k] < anchored ? est[k] : anchored) * bias;
        }
      }
      this.framesSeen++;
    }

    // Gains: MMSE-STSA (Ephraim-Malah 1984, eq. 13) with decision-directed
    // a priori SNR (eq. 51, alpha 0.98). The DD recursion is the temporal
    // smoother, so there is no gain-domain smoothing at all. Bypass forces
    // unity gain (bit-exact delay line, same latency) for toggle-off.
    //
    // Global ease: fraction of bins starved of floor evidence (no 6 dB+
    // dip for 2 s+). Sustained content starves broadly (post-transition
    // soft music, long tutti); fluctuating audio resets constantly.
    // Suppression eases proportionally -- no cliffs, self-calibrating.
    const gFloor = this.gFloor;
    let starved = 0;
    for (let k = 0; k <= this.maxBin; k++) {
      if (starve[k] > 94) starved++;
    }
    const starvedFrac = starved / (this.maxBin + 1);
    const liftedFloor = Math.pow(gFloor, 1 - 0.85 * starvedFrac);
    const maxSuppDb = this.maxSuppressionDb;
    const gain = this.gain;
    const bypass = this.bypass;
    const gateT = this.tonalityGate;
    const DD_ALPHA = 0.98;
    const XI_MIN = 0.0031622776601683794; // -25 dB
    const XI_MAX = 1000;

    for (let k = 0; k <= this.maxBin; k++) {
      if (bypass) {
        gain[k] = 1;
        cleanPow[k] = power[k];
        continue;
      }
      // Transient gate: attacks and onsets pass untouched. power[] is the
      // instantaneous frame energy, smoothed[] its slow average; a large
      // ratio marks a transient (punch, bow attacks, percussion, detail).
      // The steady wash -- hiss included -- is still suppressed. Single
      // isolated noise spikes also pass, but at ~5% of bins they cost only
      // ~0.2 dB of cut and cause no sparkle (no isolated gain wells form).
      if (power[k] > 1e-10 && power[k] > this.transientRatio * smoothed[k]) {
        gain[k] = 1;
        cleanPow[k] = power[k];
        continue;
      }
      // Tonal cap: a coherent bin is a sustained partial, so its SNR is at
      // least +9 dB -- cap the assumed noise at 1/8 of observed power.
      // Estimates may legitimately hold tone energy (seeding); without the
      // cap they would crush partials and fading tails. Failure mode is
      // safe: a hiss bin misread as tonal is only mildly under-suppressed
      // for a frame, never passed through (an exact bypass let white-noise
      // spikes through and collapsed the noise cut).
      let n = noise[k] + 1e-20;
      if (coherence[k] >= gateT) {
        const cap = power[k] * 0.125 + 1e-20;
        if (n > cap) n = cap;
      }

      let gamma = pSmooth[k] / n;
      if (gamma < 1e-6) gamma = 1e-6;
      else if (gamma > 1e4) gamma = 1e4;

      let xi = DD_ALPHA * (cleanPow[k] / n) + (1 - DD_ALPHA) * (gamma > 1 ? gamma - 1 : 0);
      if (xi < XI_MIN) xi = XI_MIN;
      else if (xi > XI_MAX) xi = XI_MAX;

      gain[k] = stsGain(xi, gamma, liftedFloor);
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
