// Bias audit: is the noise estimator unbiased on stationary noise?
// Feeds white noise at a known level through the default estimator and
// compares each tracker's time-average against the true periodogram mean.
// A raw-minimum anchor underreports by ~10log10(N); the audit measures the
// net bias after margin + pin + noiseBias compensation.
//
//   node harness/bias-audit.mjs
import { SpectralSubtractor } from '../src/dsp/spectral-subtractor.js';

const sr = 48000;
const secs = 12;
// Deterministic PRNG (mulberry32) so reruns are bit-identical.
let st = 0x12345678;
const rnd = () => {
  st |= 0; st = (st + 0x6d2b79f5) | 0;
  let t = Math.imul(st ^ (st >>> 15), 1 | st);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const amp = Math.pow(10, -40 / 20); // -40 dBFS white noise
const n = sr * secs;
const sig = new Float32Array(n);
for (let i = 0; i < n; i++) sig[i] = amp * (rnd() * 2 - 1);

const sub = new SpectralSubtractor({ sampleRate: sr });
const out = new Float32Array(1024);
const binHz = sr / 2048;
const loK = Math.max(1, Math.floor(500 / binHz));
const hiK = Math.min(sub.maxBin, Math.ceil(12000 / binHz));

// Accumulate time-averages after convergence (skip first 4 s).
const acc = { p: 0, s: 0, e: 0, m: 0, nz: 0 };
let frames = 0;
for (let off = 0; off < n; off += 1024) {
  const m = Math.min(1024, n - off);
  sub.process(sig.subarray(off, off + m), out.subarray(0, m));
  const t = off / sr;
  if (t < 4) continue;
  let p = 0, s = 0, e = 0, mm = 0, nz = 0;
  for (let k = loK; k <= hiK; k++) {
    p += sub.power[k]; s += sub.smoothed[k]; e += sub.est[k];
    mm += sub.slowMin[k]; nz += sub.noise[k];
  }
  const cnt = hiK - loK + 1;
  acc.p += p / cnt; acc.s += s / cnt; acc.e += e / cnt;
  acc.m += mm / cnt; acc.nz += nz / cnt;
  frames++;
}
for (const k of Object.keys(acc)) acc[k] /= frames;
const db = (v) => 10 * Math.log10(v + 1e-30);
console.log(`white noise -40 dBFS, ${secs}s, band 0.5-12 kHz, averaged over ${frames} post-convergence frames:`);
console.log(`  periodogram mean (truth proxy): ${db(acc.p).toFixed(2)} dB`);
console.log(`  smoothed  rel truth: ${(db(acc.s) - db(acc.p)).toFixed(2)} dB`);
console.log(`  est       rel truth: ${(db(acc.e) - db(acc.p)).toFixed(2)} dB`);
console.log(`  slowMin   rel truth: ${(db(acc.m) - db(acc.p)).toFixed(2)} dB  (raw-minimum bias)`);
console.log(`  noise     rel truth: ${(db(acc.nz) - db(acc.p)).toFixed(2)} dB  (net, incl. margin+pin+bias)`);
console.log(`  noiseBias setting: +${(20 * Math.log10(sub.noiseBias)).toFixed(1)} dB, slowMargin x${sub.slowMargin}`);
// Achieved suppression on pure noise: output vs input RMS over last 4 s.
const tail = (a) => {
  let v = 0; const from = n - 4 * sr;
  for (let i = from; i < n; i++) v += a[i] * a[i];
  return 10 * Math.log10(v / (n - from) + 1e-30);
};
const stream = new Float32Array(n + 2048);
const sub2 = new SpectralSubtractor({ sampleRate: sr });
for (let off = 0; off < n; off += 1024) {
  const m = Math.min(1024, n - off);
  sub2.process(sig.subarray(off, off + m), stream.subarray(off, off + m));
}
const cleaned = stream.slice(2048, 2048 + n);
console.log(`  achieved suppression on pure noise (last 4 s): ${(tail(cleaned) - tail(sig)).toFixed(2)} dB (floor is -15 dB)`);
