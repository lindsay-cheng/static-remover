// Pass/fail checks for the DSP core. If any of these fail, stop and say so.
//
//   node harness/test-dsp.mjs [--alpha N] [--noise-bias-db N] [--max-suppression-db N]
//
// run() returns the cleaned signal time-aligned with the input (the pipeline's
// frameSize latency is trimmed), so comparisons are sample-exact.

import { SpectralSubtractor } from '../src/dsp/spectral-subtractor.js';

const flags = new Map();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    flags.set(argv[i].slice(2), Number(argv[i + 1]));
    i++;
  }
}
const opts = {};
for (const key of ['alpha', 'noiseBiasDb', 'maxSuppressionDb', 'noiseRiseSec']) {
  const flag = key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  if (flags.has(flag)) opts[key] = flags.get(flag);
}

const sr = 48000;
const latency = 2048;

function run(sig, options) {
  const sub = new SpectralSubtractor({ sampleRate: sr, ...options });
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

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${detail})`);
  if (!ok) failures++;
}

// 1. Perfect reconstruction when alpha = 0 (after the stream-start ramp).
{
  const n = sr * 2;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sig[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr) + 0.25 * Math.sin(2 * Math.PI * 3000 * i / sr);
  }
  const out = run(sig, { alpha: 0 });
  let maxErr = 0;
  for (let i = latency; i < n; i++) {
    maxErr = Math.max(maxErr, Math.abs(out[i] - sig[i]));
  }
  check('alpha=0 reconstructs the signal exactly', maxErr < 1e-4, `max abs err ${maxErr.toExponential(2)}`);
}

// 2. A 30 s sustained tone must survive. (The old windowed-min estimator ate it.)
{
  const n = sr * 30;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sig[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr) + 0.03 * (Math.random() * 2 - 1);
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
  for (let i = 0; i < n; i++) sig[i] = 0.03 * (Math.random() * 2 - 1);
  const outDefault = run(sig, opts);
  const outStrong = run(sig, { alpha: 2, noiseBiasDb: 9, maxSuppressionDb: 18 });
  const before = bandDb(sig, sr * 5, n, 600, 1400);
  const afterDefault = bandDb(outDefault, sr * 5, n, 600, 1400);
  const afterStrong = bandDb(outStrong, sr * 5, n, 600, 1400);
  check(
    'default config gives an audible cut (>= 4 dB, 600-1400 Hz)',
    before - afterDefault >= 4,
    `${(before - afterDefault).toFixed(2)} dB reduction`,
  );
  check(
    'strong reference config keeps full headroom (>= 12 dB, 600-1400 Hz)',
    before - afterStrong >= 12,
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
    const note = (start, f) => {
      const dt = t - start;
      return dt < 0 ? 0 : 0.5 * Math.exp(-2.2 * dt) * Math.sin(2 * Math.PI * f * dt);
    };
    sig[i] = note(3, 440) + note(3.5, 554) + note(4, 659) + 0.03 * (Math.random() * 2 - 1);
  }
  const out = run(sig, opts);
  const before = rms(sig, sr * 3.05, sr * 5);
  const after = rms(out, sr * 3.05, sr * 5);
  check('decaying notes keep their level', after - before > -1, `${(after - before).toFixed(2)} dB change`);
}

console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
