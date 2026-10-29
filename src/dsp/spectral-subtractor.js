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
      restEnterFrac = 0.85,
      restExitFrac = 0.7,
      restEnterFrames = 32,
      restExtraDb = 10,
      gainAttackMs = 15,
      gainReleaseMs = 100,
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
    // Tonal cap divisor tracks the strength slider QUADRATICALLY: gentle
    // floors protect partials strictly, aggressive floors genuinely relax
    // (linear scaling left sustained-coherent passages unaffected, making
    // the slider a placebo there -- measured: floor 24/30 changed nothing).
    const sDb = Math.max(1, maxSuppressionDb);
    this.toneCapDiv = Math.max(1, Math.min(32, Math.round(8 * (15 / sDb) * (15 / sDb))));
    this.maxBin = Math.min(this.bins - 1, Math.round((maxProcessHz * frameSize) / sampleRate));
    // Bark-band index per bin for the masking lift (255 = no band).
    this.binBand = new Uint8Array(this.bins).fill(255);
    {
      const barkEdges = [
        100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720,
        2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500,
        12000, 15500, 19000,
      ];
      const binHz = sampleRate / frameSize;
      for (let b = 0; b < 24; b++) {
        const lo = Math.max(1, Math.floor(barkEdges[b] / binHz));
        const hi = Math.min(this.maxBin, Math.ceil(barkEdges[b + 1] / binHz) - 1);
        for (let k = lo; k <= hi; k++) this.binBand[k] = b;
      }
    }
    this.bandP = new Float64Array(24);
    this.bandN = new Float64Array(24);
    this.bandLift = new Float64Array(24);
    // Air-preservation cap (Cedar-style classical practice): above 8 kHz,
    // cap suppression at (maxSuppressionDb - 7) dB -- at default settings
    // -8 dB max up top instead of -15. Orchestral brilliance and hall air
    // live here alongside the hiss; hard cleaning thins timbre audibly
    // (measured: -4.3 dB selective HF loss in medium passages). Scales with
    // the strength slider (aggressive floors still bite; gentle floors pass
    // highs through entirely).
    this.hiK = Math.min(this.maxBin, Math.ceil((8000 * frameSize) / sampleRate));
    this.hiFloor = Math.pow(10, -Math.max(0, maxSuppressionDb - 7) / 20);
    this.noiseBias = Math.pow(10, noiseBiasDb / 20);
    this.beta = smoothBeta;
    this.oneMinusBeta = 1 - smoothBeta;
    this.tonalityGate = tonalityGate;
    this.tripRatio = tripRatio;
    this.tripFrames = tripFrames;
    // Rest regime: confirmed silence gets a floor restExtraDb deeper than
    // the music floor (default -25 dB), since there is nothing to protect.
    // Tracks the strength slider via maxSuppressionDb (recomputed in
    // setParams); clamped so aggressive settings cannot gate to digital
    // zero (a -40 dB bed stays inaudible without sounding dead).
    this.restEnterFrac = restEnterFrac;
    this.restExitFrac = restExitFrac;
    this.restEnterFrames = restEnterFrames;
    this.restExtraDb = restExtraDb;
    this.restFloor = Math.pow(10, -Math.min(40, maxSuppressionDb + restExtraDb) / 20);
    // Gain-domain asymmetric smoothing (Audacity 20/100 ms practice; ours
    // 15/100): one-pole coefficients per hop. Opens fast so attacks stay
    // crisp, closes slowly so suppression never chatters or pumps between
    // frames. Calibrated 2026-10-29: release 300 ms calmed flicker 5.3x but
    // cost 5.5 dB steady cut (fast-up/slow-down ratchets open on flicker);
    // 100 ms calms 2.9x for ~3.5 dB. The DD recursion smooths the estimate;
    // this smooths only the applied field (feeding it back into cleanPow
    // built an estimator loop that cost another 7 dB -- estimate fast,
    // apply smooth).
    const hopSec = hopSize / sampleRate;
    this.gainAttackMs = Math.max(1, Math.min(100, gainAttackMs));
    this.gainReleaseMs = Math.max(20, Math.min(2000, gainReleaseMs));
    this.gainAttack = 1 - Math.exp(-hopSec / (this.gainAttackMs / 1000));
    this.gainRelease = 1 - Math.exp(-hopSec / (this.gainReleaseMs / 1000));
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
    this.restCount = 0;
    this.restActive = false;
    this.initDone = false;

    // Per-bin spectrum state.
    this.power = new Float32Array(this.bins);
    this.smoothed = new Float32Array(this.bins);
    this.est = new Float32Array(this.bins);
    this.slowMin = new Float32Array(this.bins);
    this.noise = new Float32Array(this.bins);
    this.noiseS = new Float32Array(this.bins);
    this.prevRe = new Float32Array(this.bins);
    this.prevIm = new Float32Array(this.bins);
    this.crossRe = new Float32Array(this.bins);
    this.crossIm = new Float32Array(this.bins);
    this.magProd = new Float32Array(this.bins);
    this.coherence = new Float32Array(this.bins);
    this.gain = new Float32Array(this.bins);
    this.sGain = new Float32Array(this.bins);
    this.sGain.fill(1);
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
      this.maxSuppressionDb = db;
      this.hiFloor = Math.pow(10, -Math.max(0, db - 7) / 20);
      this.restFloor = Math.pow(10, -Math.min(40, db + this.restExtraDb) / 20);
      const sDb = Math.max(1, db);
      this.toneCapDiv = Math.max(1, Math.min(32, Math.round(8 * (15 / sDb) * (15 / sDb))));
    }
    if (params.noiseBiasDb !== undefined && Number.isFinite(params.noiseBiasDb)) {
      const db = Math.max(0, Math.min(20, params.noiseBiasDb));
      this.noiseBias = Math.pow(10, db / 20);
    }
    if (params.gainAttackMs !== undefined && Number.isFinite(params.gainAttackMs)) {
      this.gainAttackMs = Math.max(1, Math.min(100, params.gainAttackMs));
      this.gainAttack = 1 - Math.exp(-(this.H / this.sampleRate) / (this.gainAttackMs / 1000));
    }
    if (params.gainReleaseMs !== undefined && Number.isFinite(params.gainReleaseMs)) {
      this.gainReleaseMs = Math.max(20, Math.min(2000, params.gainReleaseMs));
      this.gainRelease = 1 - Math.exp(-(this.H / this.sampleRate) / (this.gainReleaseMs / 1000));
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
      pSmooth, cleanPow, tripCount, starve, noiseS,
      binBand, bandP, bandN, bandLift,
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
    // by loud past energy -- after a cutoff they would claim "tone" for
    // seconds (measured: stuck gains for 4+ s, then only ~-4 dB cleaning
    // indefinitely). Fires on (a) 12 dB+ single-frame drops, or (b) power
    // collapsing relative to the DD's clean-power memory (musical cutoffs
    // that complete over 2-5 frames -- too gradual for (a); cleanPow trails
    // loud past by ~50+ frames, so the ratio stays tripped only until the
    // reset lands, then self-terminates). A sharp drop means the past no
    // longer describes the present, so restart all history from current
    // evidence. Gradual decays (piano dampers, hall tails) never drop this
    // fast and are unaffected.
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

      if (
        (p < smoothed[k] * 0.0625 && smoothed[k] > 1e-8) ||
        (cleanPow[k] > 1e-9 && p < cleanPow[k] * 0.0625)
      ) {
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
          // Pin floor: never let the anchor drag N more than ~12 dB below
          // est at default strength (scales with the slider: divisors below
          // share the formula). Outlier minima (or a silence-seeded start)
          // would otherwise pin suppression near passthrough for minutes
          // (measured: ~0 dB cleaning on a silence-seeded file).
          const pinDiv = Math.max(2, 16 / (this.maxSuppressionDb / 15));
          const pinFloor = est[k] / pinDiv;
          const pin = anchored > pinFloor ? anchored : pinFloor;
          noise[k] = (est[k] < pin ? est[k] : pin) * bias;
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
    // Aggressiveness follows the strength slider (1 at default): higher
    // settings ease less on sustained content (deeper cleaning on demand);
    // lower settings ease more. Default behavior byte-identical.
    const aggr = this.maxSuppressionDb / 15;
    const liftedFloor = Math.pow(gFloor, Math.max(0, 1 - (0.85 * starvedFrac) / aggr));
    // Spectral smoothing of the noise estimate (libspecbleach): our noise[]
    // is the only un-smoothed quantity feeding the MMSE gain, and single-bin
    // floor spikes become single-bin gain wells (sparkle). 3-tap box blended
    // 50% kills them with zero temporal smearing. Edges clamp.
    noiseS[0] = 0.5 * noise[0] + 0.5 * ((noise[0] + noise[1]) / 2);
    for (let k = 1; k < bins - 1; k++) {
      noiseS[k] = 0.5 * noise[k] + 0.5 * ((noise[k - 1] + noise[k] + noise[k + 1]) / 3);
    }
    noiseS[bins - 1] = 0.5 * noise[bins - 1] + 0.5 * ((noise[bins - 2] + noise[bins - 1]) / 2);
    const gain = this.gain;
    const bypass = this.bypass;
    const gateT = this.tonalityGate;
    const DD_ALPHA = 0.98;
    const XI_MIN = 0.0031622776601683794; // -25 dB
    const XI_MAX = 1000;
    // Rest regime (two-regime sweet spot): confirmed silence gets the deep
    // rest floor, since there is no music to protect. The detector is
    // relative to our own floor estimate (self-calibrating across playback
    // levels and YouTube DRC): fraction of bins sitting within 6 dB of
    // estimated noise. Entry needs ~0.7 s consecutive (tails and ticks
    // delay it -- safe direction); exit is instant with a hysteresis band
    // against boundary flapping. On exit, reseed DD clean-power from current
    // evidence so soft entrances are not dulled by stale-low memory (same
    // philosophy as the cutoff snap).
    let nearFloor = 0;
    for (let k = 1; k <= this.maxBin; k++) {
      if (power[k] < noise[k] * 4) nearFloor++;
    }
    // No peak veto: sparse soft notes share the peak-to-mean signature of
    // loud tones (measured 60-500 in real pauses vs 501 synth tone), so no
    // threshold separates them -- and none is needed. The tonal cap stays
    // ACTIVE in rests, so sparse partials keep their +9 dB SNR protection
    // while the wash between them goes to the deep floor. Dense music fails
    // the fraction first, so rests are the only regime affected.
    const restFrac = nearFloor / this.maxBin;
    if (this.restActive) {
      if (restFrac < this.restExitFrac) {
        this.restActive = false;
        this.restCount = 0;
        for (let k = 0; k <= this.maxBin; k++) cleanPow[k] = power[k];
      }
    } else if (restFrac > this.restEnterFrac) {
      if (++this.restCount >= this.restEnterFrames) {
        this.restActive = true;
      }
    } else {
      this.restCount = 0;
    }
    const rest = this.restActive;
    const restFloor = this.restFloor;

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
      // Tonal cap: a coherent bin is a sustained partial. Cap the assumed
      // noise at observed power / toneCapDiv (default /8 = +9 dB SNR floor).
      // Scales with the strength slider (gentle floors protect strictly,
      // aggressive floors cut deeper on explicit user request). Estimates
      // may legitimately hold tone energy (seeding); without the cap they
      // would crush partials and fading tails. Failure mode is safe: a hiss
      // bin misread as tonal is only mildly under-suppressed for a frame,
      // never passed through.
      let n = noiseS[k] + 1e-20;
      // Tonal cap stays active in rests (it is what lets sparse pause-notes
      // through); the deep floor + relaxed air cap do the extra work on the
      // wash between partials.
      if (coherence[k] >= gateT) {
        const cap = power[k] / this.toneCapDiv + 1e-20;
        if (n > cap) n = cap;
      }

      let gamma = pSmooth[k] / n;
      if (gamma < 1e-6) gamma = 1e-6;
      else if (gamma > 1e4) gamma = 1e4;

      // Decision-directed a priori SNR (Ephraim-Malah eq. 51, fixed 0.98).
      // Deliberately NOT SNR-dependent: an iZotope-style alpha that trusts
      // the frame at high gamma cost 2.5 dB of steady-hiss cut while buying
      // nothing measurable (attacks already pass via gamma-dominance: at
      // high gamma G->1 for any xi, suite attacks read 0.0 ms either way).
      let xi = DD_ALPHA * (cleanPow[k] / n) + (1 - DD_ALPHA) * (gamma > 1 ? gamma - 1 : 0);
      if (xi < XI_MIN) xi = XI_MIN;
      else if (xi > XI_MAX) xi = XI_MAX;

      // Soft-knee floor (Acon-style): round the clamp instead of snapping
      // to it (k = 0.03, ~0.7 dB lift at most). Removes the hard edge that
      // turns near-floor bins into on/off gates.
      const gRaw = stsGain(xi, gamma, 0);
      const fl = rest ? restFloor : (k >= this.hiK ? Math.max(liftedFloor, this.hiFloor) : liftedFloor);
      const dknee = 0.03;
      gain[k] = 0.5 * (gRaw + fl + Math.sqrt((gRaw - fl) * (gRaw - fl) + dknee * dknee));
      cleanPow[k] = gain[k] * gain[k] * power[k];
    }
    // Masking-aware lift (iZotope-style): where the residual hiss sits far
    // below the music in a Bark band, ease suppression back toward unity --
    // removing inaudible noise buys nothing and costs detail. liftDb ramps
    // 0-8 dB from 18 dB band SNR, smoothed across bands; capped so it can
    // never undo the requested reduction, and applied before spike repair
    // (whistle-closing wins ties).
    {
      bandP.fill(0);
      bandN.fill(0);
      for (let k = 1; k <= this.maxBin; k++) {
        const b = binBand[k];
        if (b === 255) continue;
        const g = gain[k];
        bandP[b] += pSmooth[k];
        bandN[b] += noiseS[k] * g * g;
      }
      for (let b = 0; b < 24; b++) {
        const s = bandP[b] - bandN[b];
        const snr = 10 * Math.log10((s > 0 ? s : 0) / (bandN[b] + 1e-20) + 1e-20);
        const lift = 0.5 * (snr - 18);
        const liftCap = 8 / aggr;
        bandLift[b] = lift < 0 ? 0 : lift > liftCap ? liftCap : lift;
      }
      let prev = bandLift[0];
      for (let b = 0; b < 23; b++) {
        const cur = bandLift[b];
        bandLift[b] = 0.25 * prev + 0.5 * cur + 0.25 * bandLift[b + 1];
        prev = cur;
      }
      for (let k = 1; k <= this.maxBin; k++) {
        const b = binBand[k];
        if (b === 255) continue;
        const l = bandLift[b];
        if (l > 0.05) {
          const g = gain[k] * Math.pow(10, l / 20);
          gain[k] = g > 1 ? 1 : g;
          cleanPow[k] = gain[k] * gain[k] * power[k];
        }
      }
    }
    // Isolated-spike repair (SoX "tinkle bell"): a lone half-open bin amid
    // deeply suppressed neighbours is a musical-noise whistle -- close it.
    // Thresholds widened slightly for a continuous (non-binary) gain field.
    for (let k = 2; k <= this.maxBin - 2; k++) {
      const g = gain[k];
      if (
        g >= 0.45 &&
        g <= 0.58 &&
        gain[k - 1] < 0.15 &&
        gain[k - 2] < 0.15 &&
        gain[k + 1] < 0.15 &&
        gain[k + 2] < 0.15
      ) {
        const repairFloor = rest ? restFloor : liftedFloor;
        gain[k] = repairFloor;
        cleanPow[k] = repairFloor * repairFloor * power[k];
      }
    }
    gain[0] = 1;
    for (let k = this.maxBin + 1; k < bins; k++) {
      gain[k] = 1;
      cleanPow[k] = power[k];
    }

    // Asymmetric gain smoothing: open fast, close slowly. Bypass snaps to
    // unity (toggle-off stays bit-exact); bin 0 is pinned to 1 so DC
    // reconstruction stays exact. cleanPow tracks the APPLIED gain so the
    // DD recursion sees what the ear gets.
    const sGain = this.sGain;
    if (bypass) {
      sGain.fill(1);
    } else {
      const atk = this.gainAttack;
      const rel = this.gainRelease;
      sGain[0] = 1;
      for (let k = 1; k <= this.maxBin; k++) {
        const g = gain[k];
        const s = sGain[k];
        sGain[k] = s + (g - s) * (g > s ? atk : rel);
      }
    }

    // Apply gains; mirror onto the negative-frequency bins. cleanPow is
    // deliberately NOT updated here: it tracks the instantaneous
    // (pre-smoothing) gain so the DD recursion keeps its fast dynamics --
    // feeding it the smoothed gain built a feedback loop (open gains ->
    // high cleanPow -> high xi -> open gains) that cost 12 dB of steady
    // cut. Estimate fast, apply smooth.
    for (let k = 0; k <= this.maxBin; k++) {
      const g = bypass ? 1 : sGain[k];
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
