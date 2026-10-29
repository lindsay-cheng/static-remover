// Canonical acceptance gates on real recordings: cleaning power where hiss
// dominates, transparency where music dominates. Deterministic (same code +
// same inputs => same numbers), so these are regression gates: they catch
// future changes that clean less or damage more. They do NOT prove quality
// by themselves -- residual.mjs (what was removed) informs direction.
//
// Metrology reuses quality.mjs (sharp DFT bands), NOT ffmpeg biquads:
// gentle filter skirts leak piano harmonics into the band and understate
// real cuts by several dB (measured: 1.6 dB vs 6.1 dB on the same files).
//
// Expects (produced by accept-samples.sh):
//   ../audio/outputs/accept-A.wav       (Rach, quiet static)
//   ../audio/outputs/accept-B.wav       (Rach, full mix)
//   ../audio/outputs/accept-chopin.wav  (Chopin, quiet theme)
//
//   bash harness/accept-samples.sh && node harness/accept.mjs

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function quality(inWav, outWav, fromSec, toSec) {
  const cmd = `node '${join(HERE, 'quality.mjs')}' '${inWav}' '${outWav}' ${fromSec} ${toSec}`;
  const out = execFileSync(cmd, { encoding: 'utf8', shell: true });
  const get = (label) => {
    const m = out.match(new RegExp(label + ': ([-\\d.]+) dB'));
    if (!m) throw new Error(`parse failed for ${label} in:\n${out}`);
    return Number(m[1]);
  };
  return {
    overall: get('overall level'),
    static: get('static band 2-8 kHz'),
    high: get('high band 4-13 kHz'),
  };
}

const PROJ = join(HERE, '..', '..');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${detail})`);
  if (!ok) failures++;
}

// A: Rach quiet static 2-14 s -- must CLEAN.
{
  const q = quality(PROJ + '/audio/outputs/sampleA-in.wav', PROJ + '/audio/outputs/accept-A.wav', 2, 14);
  check('Rach quiet: static band cut >= 8 dB', q.static <= -8, `${q.static.toFixed(2)} dB`);
}

// B: Rach full mix -- must PRESERVE.
{
  const q = quality(PROJ + '/audio/outputs/sampleB-in.wav', PROJ + '/audio/outputs/accept-B.wav', 0, 0);
  check('Rach mix: overall change >= -1.5 dB', q.overall >= -1.5, `${q.overall.toFixed(2)} dB`);
  check('Rach mix: high band change >= -2 dB', q.high >= -2, `${q.high.toFixed(2)} dB`);
}

// Chopin quiet theme 14-20 s -- must CLEAN static while keeping overall close.
{
  const q = quality(
    PROJ + '/audio/inputs/chopin-zimerman-1984/chopin-theme.wav',
    PROJ + '/audio/outputs/accept-chopin.wav',
    14,
    20,
  );
  check('Chopin theme: static band cut >= 4 dB', q.static <= -4, `${q.static.toFixed(2)} dB`);
  check('Chopin theme: overall change >= -2.5 dB', q.overall >= -2.5, `${q.overall.toFixed(2)} dB`);
}

console.log(failures === 0 ? 'all acceptance gates passed' : `${failures} gate(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
