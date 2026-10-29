// Muffle meter: scores a (in.wav, clean.wav) pair on music preservation +
// static removal using windowed FFT analysis. The whole point is making
// "underwater" measurable so presets can be compared without listening.
//
//   node harness/quality.mjs <in.wav> <clean.wav> [fromSec] [toSec]
//
// Prints: overall level change, static-band (2-8 kHz) change, high-band
// (4-13 kHz) change, spectral centroid in->out, crest factor in->out.
// Preservation bar: high-band change > -1 dB, centroid shift < 5%.

import { decodeWav } from './wav-io.mjs';
import { FFT } from '../src/dsp/fft.js';

const [inPath, outPath, fromSec = '0', toSec = '0'] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: node harness/quality.mjs <in.wav> <clean.wav> [fromSec] [toSec]');
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

const from = Math.floor(Number(fromSec) * sr);
const to = Number(toSec) > 0 ? Math.floor(Number(toSec) * sr) : x.length;

const fft = new FFT(4096);
const re = new Float32Array(4096);
const im = new Float32Array(4096);
const win = new Float32Array(4096);
for (let i = 0; i < 4096; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 4096);

let band28x = 0;
let band28y = 0;
let band413x = 0;
let band413y = 0;
let centX = 0;
let centY = 0;
let totX = 0;
let totY = 0;
let windows = 0;
const binHz = sr / 4096;
for (let off = from; off + 4096 <= to; off += 2048) {
  for (let i = 0; i < 4096; i++) {
    re[i] = x[off + i] * win[i];
    im[i] = 0;
  }
  fft.forward(re, im);
  let e28x = 0;
  let e413x = 0;
  let cx = 0;
  let tx = 0;
  for (let k = 1; k <= 2048; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    const f = k * binHz;
    if (f >= 2000 && f <= 8000) e28x += p;
    if (f >= 4000 && f <= 13000) e413x += p;
    cx += f * p;
    tx += p;
  }
  for (let i = 0; i < 4096; i++) {
    re[i] = y[off + i] * win[i];
    im[i] = 0;
  }
  fft.forward(re, im);
  let e28y = 0;
  let e413y = 0;
  let cy = 0;
  let ty = 0;
  for (let k = 1; k <= 2048; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    const f = k * binHz;
    if (f >= 2000 && f <= 8000) e28y += p;
    if (f >= 4000 && f <= 13000) e413y += p;
    cy += f * p;
    ty += p;
  }
  band28x += e28x;
  band28y += e28y;
  band413x += e413x;
  band413y += e413y;
  centX += cx / (tx + 1e-20);
  centY += cy / (ty + 1e-20);
  totX += tx;
  totY += ty;
  windows++;
}

let peakX = 0;
let peakY = 0;
let eX = 0;
let eY = 0;
for (let i = from; i < to; i++) {
  peakX = Math.max(peakX, Math.abs(x[i]));
  peakY = Math.max(peakY, Math.abs(y[i]));
  eX += x[i] * x[i];
  eY += y[i] * y[i];
}
const n = to - from;
const crestX = peakX / (Math.sqrt(eX / n) + 1e-20);
const crestY = peakY / (Math.sqrt(eY / n) + 1e-20);

const db = (v) => 10 * Math.log10(v + 1e-20);
console.log(`windows: ${windows} over ${((to - from) / sr).toFixed(1)}s @ ${sr} Hz`);
console.log(`overall level: ${db(totY / (totX + 1e-20)).toFixed(2)} dB`);
console.log(`static band 2-8 kHz: ${db(band28y / (band28x + 1e-20)).toFixed(2)} dB (more negative = more static removed)`);
console.log(`high band 4-13 kHz: ${db(band413y / (band413x + 1e-20)).toFixed(2)} dB (want > -1: muffling if lower)`);
console.log(`centroid: ${(centX / windows).toFixed(0)} -> ${(centY / windows).toFixed(0)} Hz (${(100 * (centY - centX) / (centX + 1e-20)).toFixed(1)}% shift)`);
console.log(`crest: ${crestX.toFixed(2)} -> ${crestY.toFixed(2)} (transient smear if falling)`);
