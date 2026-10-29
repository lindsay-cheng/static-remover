// Pass/fail checks for the DSP core. If any of these fail, stop and say so.
//
//   node harness/test-dsp.mjs [--noise-bias-db N] [--max-suppression-db N]
//
// run() returns the cleaned signal time-aligned with the input (the pipeline's
// frameSize latency is trimmed), so comparisons are sample-exact.

import { SpectralSubtractor, stsGain } from '../src/dsp/spectral-subtractor.js';

const flags = new Map();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    flags.set(argv[i].slice(2), Number(argv[i + 1]));
    i++;
  }
}
const opts = {};
for (const key of ['noiseBiasDb', 'maxSuppressionDb', 'noiseRiseSec']) {
  const flag = key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  if (flags.has(flag)) opts[key] = flags.get(flag);
}

const sr = 48000;
const latency = 2048;

// Deterministic PRNG: test thresholds must mean the same thing on every run.
// (Math.random seed variance was ±1.5 dB on the noise checks -- wider than
// the margins being tuned.)
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(1337);

function run(sig, options, bypassed = false) {
  const sub = new SpectralSubtractor({ sampleRate: sr, ...options });
  if (bypassed) sub.setBypassed(true);
  const stream = new Float32Array(sig.length + latency);
  for (let off = 0; off < sig.length; off += 1024) {
    const n = Math.min(1024, sig.length - off);
    sub.process(sig.subarray(off, off + n), stream.subarray(off, off + n));
  }
  const zeros = new Float32Array(1024);
  for (let off = 0; off < latency; off += 1024) {
    const n = Math.min(1024, latency - off);
    sub.process(zeros.subarray(0, n), stream.subarray(sig.length + off, sig.length + off + n));
  }
  return stream.slice(latency, latency + sig.length);
}

function rms(x, from, to) {
  let v = 0;
  for (let i = from; i < to; i++) v += x[i] * x[i];
  return 20 * Math.log10(Math.sqrt(v / (to - from)) + 1e-20);
}

// Energy in a frequency band via direct DFT at log-spaced frequencies, in dB.
// Used for noise reduction because the DSP deliberately passes everything
// above 16 kHz (plan: "do not process above 16 kHz"), so whole-spectrum RMS
// would count bypassed energy as "unsuppressed".
function bandDb(x, from, to, f0, f1) {
  const probes = 8;
  let energy = 0;
  for (let q = 0; q < probes; q++) {
    const f = f0 * Math.pow(f1 / f0, q / (probes - 1));
    let re = 0;
    let im = 0;
    for (let i = from; i < to; i++) {
      const ang = (2 * Math.PI * f * i) / sr;
      re += x[i] * Math.cos(ang);
      im += x[i] * Math.sin(ang);
    }
    energy += (re * re + im * im) / ((to - from) * (to - from));
  }
  return 10 * Math.log10(energy + 1e-20);
}

// Piano-like note: fundamental + 12 harmonics (1/h^1.5 falloff, faster decay
// up top), so the spectrum has real high-frequency content like the recording.
function pianoNote(t, start, f) {
  const dt = t - start;
  if (dt < 0) return 0;
  let v = 0;
  for (let h = 1; h <= 12; h++) {
    v +=
      (0.5 / Math.pow(h, 1.5)) *
      Math.exp(-2.2 * dt * (1 + 0.25 * (h - 1))) *
      Math.sin(2 * Math.PI * f * h * dt);
  }
  return v;
}
let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${detail})`);
  if (!ok) failures++;
}

// 0. STSA gain matches published reference values (Ephraim-Malah eq. 13).
{
  const cases = [
    [1.0, 1, 0.7743],
    [0.5, 1, 0.5936],
    [0.1, 0.2, 0.6029],
    [10, 10, 0.9345],
    // nu = 100*100/101 > 50, so the Wiener asymptote xi/(1+xi) applies
    // (exact to 0.043 dB per Ephraim-Malah; here 0.022 dB).
    [100, 100, 100 / 101],
  ];
  let maxErr = 0;
  for (const [xi, gamma, expected] of cases) {
    maxErr = Math.max(maxErr, Math.abs(stsGain(xi, gamma) - expected));
  }
  check('STSA gain matches reference values', maxErr < 1e-3, `max abs err ${maxErr.toExponential(2)}`);
}

// 1. Perfect reconstruction when bypassed (after the stream-start ramp).
{
  const n = sr * 2;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sig[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr) + 0.25 * Math.sin(2 * Math.PI * 3000 * i / sr);
  }
  const out = run(sig, {}, true);
  let maxErr = 0;
  for (let i = latency; i < n; i++) {
    maxErr = Math.max(maxErr, Math.abs(out[i] - sig[i]));
  }
  check('bypass reconstructs the signal exactly', maxErr < 1e-4, `max abs err ${maxErr.toExponential(2)}`);
}

// 2. A 30 s sustained tone must survive. (The old windowed-min estimator ate it.)
{
  const n = sr * 30;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sig[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr) + 0.03 * (rand() * 2 - 1);
  }
  const out = run(sig, opts);
  const before = rms(sig, sr * 5, n);
  const after = rms(out, sr * 5, n);
  check('30 s sustained tone survives', after - before > -2, `${(after - before).toFixed(2)} dB change`);
}

// 3. Noise floor must drop clearly (measured in the processed band, after the
//    estimator has converged). Two pinned configs: the shipping default must
//    give an audible cut, and the strong reference config must show the
//    engine's full headroom (guards against estimator regressions, which
//    historically measured 2-4 dB).
{
  const n = sr * 12;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = 0.03 * (rand() * 2 - 1);
  const outDefault = run(sig, opts);
  const outStrong = run(sig, { maxSuppressionDb: 18 });
  const before = bandDb(sig, sr * 5, n, 600, 1400);
  const afterDefault = bandDb(outDefault, sr * 5, n, 600, 1400);
  const afterStrong = bandDb(outStrong, sr * 5, n, 600, 1400);
  check(
    'default config gives an audible cut (>= 4 dB, 600-1400 Hz)',
    before - afterDefault >= 4,
    `${(before - afterDefault).toFixed(2)} dB reduction`,
  );
  check(
    'strong reference config keeps headroom (>= 6 dB, 600-1400 Hz)',
    before - afterStrong >= 6,
    `${(before - afterStrong).toFixed(2)} dB reduction`,
  );
}

// 4. Decaying piano-like notes must not lose level. The noise floor runs for
//    3 s first so the estimator has converged before the notes enter.
{
  const n = sr * 12;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    sig[i] =
      pianoNote(t, 3, 440) +
      pianoNote(t, 3.5, 554) +
      pianoNote(t, 4, 659) +
      0.03 * (rand() * 2 - 1);
  }
  const out = run(sig, opts);
  const before = rms(sig, sr * 3.05, sr * 5);
  const after = rms(out, sr * 3.05, sr * 5);
  check('decaying notes keep their level', after - before > -1, `${(after - before).toFixed(2)} dB change`);
}

// 5. Sustained HF-rich complex + noise vs the same complex clean: the
//    harmonics must survive (tests the tonality gate + STSA where the
//    reference band is genuinely music-dominated).
{
  const n = sr * 12;
  const ref = new Float32Array(n);
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let music = 0;
    for (let h = 1; h <= 6; h++) {
      music += (0.3 / h) * Math.sin(2 * Math.PI * 2000 * h * t);
    }
    ref[i] = music;
    sig[i] = music + 0.03 * (rand() * 2 - 1);
  }
  const out = run(sig, opts);
  const from = sr * 5;
  const to = n;
  const dAll = rms(out, from, to) - rms(ref, from, to);
  const dHi = bandDb(out, from, to, 4000, 13000) - bandDb(ref, from, to, 4000, 13000);
  const muffle = dHi - dAll;
  check('HF harmonics survive noise + processing (muffle >= -1.5 dB)', muffle >= -1.5, `muffle ${muffle.toFixed(2)} dB`);
}

// 6. Sharp attacks survive (no smearing): strikes with 2 ms attacks + hiss.
//    Attack time (10-90% of local peak) must not stretch, peaks must hold.
//    Uniform noise is bounded well below the 10% threshold by construction,
//    so the measurement cannot trigger on hiss.
function measureAttack(x, startIdx) {
  const end = Math.min(x.length, startIdx + Math.floor(0.1 * sr));
  let peak = 0;
  let pi = startIdx;
  for (let i = startIdx; i < end; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) {
      peak = a;
      pi = i;
    }
  }
  const lo = Math.max(0, pi - Math.floor(0.05 * sr));
  let t10 = pi;
  let t90 = pi;
  for (let i = lo; i <= pi; i++) {
    if (Math.abs(x[i]) >= 0.1 * peak) {
      t10 = i;
      break;
    }
  }
  for (let i = lo; i <= pi; i++) {
    if (Math.abs(x[i]) >= 0.9 * peak) {
      t90 = i;
      break;
    }
  }
  return {
    attackMs: ((t90 - t10) / sr) * 1000,
    peakDb: 20 * Math.log10(peak + 1e-20),
  };
}

{
  const n = sr * 6;
  const sig = new Float32Array(n);
  const strike = (start, f) => {
    for (let i = 0; i < n; i++) {
      const t = i / sr - start;
      if (t < 0 || t > 1.5) continue;
      const a = Math.min(1, t / 0.002);
      const env = a * a * Math.exp(-3 * t);
      sig[i] +=
        0.5 *
        env *
        (Math.sin(2 * Math.PI * f * t) +
          0.4 * Math.sin(2 * Math.PI * 2 * f * t) +
          0.2 * Math.sin(2 * Math.PI * 3 * f * t));
    }
  };
  strike(1, 440);
  strike(2.5, 554);
  strike(4, 659);
  for (let i = 0; i < n; i++) sig[i] += 0.03 * (rand() * 2 - 1);
  const out = run(sig, opts);
  let worstStretch = 0;
  let worstPeak = 0;
  const detail = [];
  for (const start of [1, 2.5, 4]) {
    const m = measureAttack(sig, Math.floor(start * sr));
    const o = measureAttack(out, Math.floor(start * sr));
    worstStretch = Math.max(worstStretch, o.attackMs - m.attackMs);
    worstPeak = Math.min(worstPeak, o.peakDb - m.peakDb);
    detail.push(`${start}s: ${(o.attackMs - m.attackMs).toFixed(1)}ms/${(o.peakDb - m.peakDb).toFixed(2)}dB`);
  }
  check('attacks not smeared (stretch <= +10 ms)', worstStretch <= 10, detail.join(' '));
  check('attack peaks hold (>= -1 dB)', worstPeak >= -1, detail.join(' '));
}

console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
