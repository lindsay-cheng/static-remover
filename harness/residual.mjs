// Residue monitor (iZotope/Acon "solo noise" workflow, harness edition):
// what is the denoiser actually removing -- hiss or music? Compares
// in.wav vs clean.wav (must be time-aligned, as denoise-file.mjs writes)
// and prints per-band levels of input, output, and residual (in - out).
// A healthy result: residual concentrated where the hiss lives, output
// matching input where the music lives.
//
//   node harness/residual.mjs <in.wav> <clean.wav> [fromSec] [toSec]

import { decodeWav } from './wav-io.mjs';
import { FFT } from '../src/dsp/fft.js';

const [inPath, outPath, fromSec = '0', toSec = '0'] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: node harness/residual.mjs <in.wav> <clean.wav> [fromSec] [toSec]');
  process.exit(1);
}

async function readBytes(path) {
  if (globalThis.Deno) return await Deno.readFile(path);
  return await (await import('node:fs/promises')).readFile(path);
}

const a = decodeWav(await readBytes(inPath));
const b = decodeWav(await readBytes(outPath));
if (a.sampleRate !== b.sampleRate || a.frames !== b.frames) {
  throw new Error('in/clean mismatch');
}
const sr = a.sampleRate;
const mono = (ch) => {
  const m = new Float32Array(ch[0].length);
  for (let i = 0; i < m.length; i++) {
    let v = 0;
    for (const c of ch) v += c[i];
    m[i] = v / ch.length;
  }
  return m;
};
const x = mono(a.channels);
const y = mono(b.channels);
const r = new Float32Array(x.length);
for (let i = 0; i < r.length; i++) r[i] = x[i] - y[i];

const from = Math.floor(Number(fromSec) * sr);
const to = Number(toSec) > 0 ? Math.floor(Number(toSec) * sr) : x.length;

const fft = new FFT(4096);
const re = new Float32Array(4096);
const im = new Float32Array(4096);
const win = new Float32Array(4096);
for (let i = 0; i < 4096; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 4096);

const bands = [
  ['62-125', 62, 125],
  ['125-250', 125, 250],
  ['250-500', 250, 500],
  ['500-1k', 500, 1000],
  ['1k-2k', 1000, 2000],
  ['2k-4k', 2000, 4000],
  ['4k-8k', 4000, 8000],
  ['8k-13k', 8000, 13000],
];
const acc = bands.map(() => [0, 0, 0]);
let windows = 0;
const binHz = sr / 4096;
for (let off = from; off + 4096 <= to; off += 2048) {
  const spec = (sig) => {
    for (let i = 0; i < 4096; i++) {
      re[i] = sig[off + i] * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    const out = new Float64Array(2049);
    for (let k = 0; k <= 2048; k++) out[k] = re[k] * re[k] + im[k] * im[k];
    return out;
  };
  const sx = spec(x);
  const sy = spec(y);
  const sr2 = spec(r);
  bands.forEach(([label, f0, f1], bi) => {
    for (let k = 1; k <= 2048; k++) {
      const f = k * binHz;
      if (f < f0 || f > f1) continue;
      acc[bi][0] += sx[k];
      acc[bi][1] += sy[k];
      acc[bi][2] += sr2[k];
    }
  });
  windows++;
}

const db = (v) => 10 * Math.log10(v + 1e-20);
console.log(`residual over ${((to - from) / sr).toFixed(1)}s @ ${sr} Hz (${windows} windows)`);
console.log('band      in       out      removed  (dB)');
for (let bi = 0; bi < bands.length; bi++) {
  const [label] = bands[bi];
  const [ex, ey, er] = acc[bi];
  console.log(
    `${label.padEnd(9)} ${db(ex).toFixed(1).padStart(7)} ${db(ey).toFixed(1).padStart(7)} ${db(er).toFixed(1).padStart(7)}` +
      (db(ey) < db(ex) - 3 ? '  <-- cleaning here' : ''),
  );
}
