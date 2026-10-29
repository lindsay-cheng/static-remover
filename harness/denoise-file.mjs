// Offline tuning harness: runs the exact DSP core the extension will use over
// a WAV file. Slice 1's tuning loop lives here.
//
// Usage:
//   node harness/denoise-file.mjs <in.wav> <out.wav> [--alpha 2.0] [--max-suppression-db 18]
//
// The output is time-aligned with the input (the pipeline's frameSize latency
// is trimmed), so before/after comparisons stay sample-exact.

import { decodeWav, encodeWavPcm16 } from './wav-io.mjs';
import { SpectralSubtractor } from '../src/dsp/spectral-subtractor.js';

const args = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    flags.set(args[i].slice(2), Number(args[i + 1]));
    i++;
  } else {
    positional.push(args[i]);
  }
}

const [inPath, outPath] = positional;
if (!inPath || !outPath) {
  console.error('usage: node harness/denoise-file.mjs <in.wav> <out.wav> [--max-suppression-db N] [--noise-bias-db N] ...');
  process.exit(1);
}

const optionFlags = {
  'max-suppression-db': 'maxSuppressionDb',
  'noise-bias-db': 'noiseBiasDb',
  'noise-rise-sec': 'noiseRiseSec',
  'transient-ratio': 'transientRatio',
  'tonality-gate': 'tonalityGate',
  'init-sec': 'initSec',
};
const options = {};
for (const [flag, key] of Object.entries(optionFlags)) {
  if (flags.has(flag)) options[key] = flags.get(flag);
}

const wav = decodeWav(await readBytes(inPath));
const params = new SpectralSubtractor({ sampleRate: wav.sampleRate, ...options });
const frameSize = params.N;

const block = 1024;
const zeroBlock = new Float32Array(block);
const scratch = new Float32Array(block);
const outChannels = [];

for (const input of wav.channels) {
  // The streaming output is the input delayed by frameSize samples, with
  // frameSize zeros of pipeline fill at the head.
  const stream = new Float32Array(wav.frames + frameSize);
  const sub = new SpectralSubtractor({ sampleRate: wav.sampleRate, ...options });

  for (let off = 0; off < wav.frames; off += block) {
    const n = Math.min(block, wav.frames - off);
    sub.process(input.subarray(off, off + n), stream.subarray(off, off + n));
  }
  // Flush the pipeline so the tail comes out.
  for (let off = 0; off < frameSize; off += block) {
    sub.process(zeroBlock, scratch);
  }

  outChannels.push(stream.slice(frameSize, frameSize + wav.frames));
}

await writeBytes(outPath, encodeWavPcm16(wav.sampleRate, outChannels));
console.log(
  `denoised ${inPath} -> ${outPath} ` +
    `(${wav.frames} frames, ${wav.sampleRate} Hz, floor=${(20 * Math.log10(params.gFloor)).toFixed(1)} dB, latency=${frameSize} samples)`,
);

async function readBytes(path) {
  if (globalThis.Deno) return await Deno.readFile(path);
  return await (await import('node:fs/promises')).readFile(path);
}

async function writeBytes(path, bytes) {
  if (globalThis.Deno) {
    await Deno.writeFile(path, bytes);
    return;
  }
  await (await import('node:fs/promises')).writeFile(path, bytes);
}
