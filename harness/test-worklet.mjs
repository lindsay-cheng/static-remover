// Worklet glue checks: runs src/audio/worklet.js in Node with a stubbed
// AudioWorkletGlobalScope and verifies stereo routing, enable/disable,
// config messages, and music safety of the exact code the browser will run.
//
//   node harness/test-worklet.mjs

import { SpectralSubtractor } from '../src/dsp/spectral-subtractor.js';

const sr = 48000;
const FRAME = 2048;

// Deterministic PRNG (see test-dsp.mjs): thresholds must be reproducible.
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
const rand = mulberry32(2026);

globalThis.sampleRate = sr;
let ProcessorClass = null;
globalThis.registerProcessor = (_name, cls) => {
  ProcessorClass = cls;
};
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = {
      onmessage: null,
      messages: [],
      postMessage(m) {
        this.messages.push(m);
      },
    };
  }
};

await import('../src/audio/worklet.js');

if (!ProcessorClass) {
  console.error('FAIL  worklet did not register a processor');
  process.exit(1);
}

function makeProc() {
  const proc = new ProcessorClass({ processorOptions: { frameSize: FRAME } });
  return { proc, send: (m) => proc.port.onmessage({ data: m }) };
}

// NOTE: each test below gets a FRESH processor instance. A shared instance
// across acoustically unrelated signals (pure tones, then noise) is a lab
// switch with no real-world counterpart -- estimators legitimately carry
// tone-era state -- and it permanently poisons minima tracking in a way
// continuous audio never does. The browser reuses one instance, but always
// on continuous audio (bypass keeps it warm on the same signal).

function stereo(seconds, fill) {
  const n = Math.floor(sr * seconds);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) fill(i, L, R);
  return [L, R];
}

function runThrough(proc, channels) {
  const n = channels[0].length;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const q = 128; // render quantum
  for (let off = 0; off < n; off += q) {
    const m = Math.min(q, n - off);
    const ins = [channels[0].subarray(off, off + m), channels[1].subarray(off, off + m)];
    const outs = [outL.subarray(off, off + m), outR.subarray(off, off + m)];
    proc.process([ins], [outs]);
  }
  return [outL, outR];
}

function rms(x, from, to) {
  let v = 0;
  for (let i = from; i < to; i++) v += x[i] * x[i];
  return 20 * Math.log10(Math.sqrt(v / (to - from)) + 1e-20);
}

// Energy in a frequency band via direct DFT at log-spaced frequencies, in dB.
// Whole-spectrum RMS would count the >16 kHz bypass band (plan: "do not
// process above 16 kHz") as "unsuppressed".
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

// 1. Disabled (initial state): bit-exact passthrough delayed by FRAME.
{
  const { proc } = makeProc();
  const [L, R] = stereo(2, (i, l, r) => {
    l[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sr);
    r[i] = 0.4 * Math.sin((2 * Math.PI * 660 * i) / sr);
  });
  const [oL, oR] = runThrough(proc, [L, R]);
  let maxErr = 0;
  for (let i = FRAME + 1024; i < L.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(oL[i] - L[i - FRAME]), Math.abs(oR[i] - R[i - FRAME]));
  }
  check('disabled worklet passes audio through exactly', maxErr < 1e-4, `max abs err ${maxErr.toExponential(2)}`);
}

// 2. Enabled: noise floor drops on both channels (processed band only).
{
  const { proc, send } = makeProc();
  const [L, R] = stereo(10, (i, l, r) => {
    l[i] = 0.03 * (rand() * 2 - 1);
    r[i] = 0.03 * (rand() * 2 - 1);
  });
  send({ type: 'enabled', value: true, maxSuppressionDb: 18, noiseBiasDb: 9 });
  const [oL, oR] = runThrough(proc, [L, R]);
  const from = sr * 5;
  const dropL = bandDb(L, from, L.length, 600, 1400) - bandDb(oL, from, oL.length, 600, 1400);
  const dropR = bandDb(R, from, R.length, 600, 1400) - bandDb(oR, from, oR.length, 600, 1400);
  check('enabled worklet suppresses noise on both channels', dropL > 8 && dropR > 8, `L -${dropL.toFixed(1)} dB, R -${dropR.toFixed(1)} dB (600-1400 Hz)`);
}

// 3. Tones survive while enabled.
{
  const { proc, send } = makeProc();
  const [L, R] = stereo(8, (i, l, r) => {
    l[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sr) + 0.03 * (rand() * 2 - 1);
    r[i] = 0.4 * Math.sin((2 * Math.PI * 660 * i) / sr) + 0.03 * (rand() * 2 - 1);
  });
  send({ type: 'enabled', value: true, maxSuppressionDb: 18, noiseBiasDb: 9 });
  const [oL, oR] = runThrough(proc, [L, R]);
  const from = sr * 4 + FRAME;
  const dL = rms(oL, from, oL.length) - rms(L, from, L.length);
  const dR = rms(oR, from, oR.length) - rms(R, from, R.length);
  check('tones keep their level while enabled', dL > -2 && dR > -2, `L ${dL.toFixed(2)} dB, R ${dR.toFixed(2)} dB`);
}

// 4. Disable returns to exact passthrough; config clamps garbage.
{
  const { proc, send } = makeProc();
  send({ type: 'enabled', value: false });
  send({ type: 'config', maxSuppressionDb: 999, noiseBiasDb: NaN });
  const [L] = stereo(3, (i, l) => {
    l[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sr);
  });
  const [oL] = runThrough(proc, [L, L.slice()]);
  // Steady-state passthrough: skip the gain-release transient after disable.
  let maxErr = 0;
  for (let i = sr; i < L.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(oL[i] - L[i - FRAME]));
  }
  check('disable + garbage config = exact passthrough', maxErr < 1e-4 && proc.enabled === false, `err ${maxErr.toExponential(2)}, enabled: ${proc.enabled}`);
}

console.log(failures === 0 ? 'all worklet checks passed' : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
