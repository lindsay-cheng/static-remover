#!/usr/bin/env bash
# Slice 1 tuning loop: run the DSP core over the Rach 3 samples (and two
# synthetic tests) and print before/after evidence.
#
#   bash harness/run-samples.sh
#   ALPHA=2.5 SUPP=20 bash harness/run-samples.sh   # sweep parameters
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJ="$(cd "$HERE/../.." && pwd)"
SAMPLES="$PROJ/audio/inputs/rach3-bronfman-2004"
OUT="$PROJ/audio/outputs"
mkdir -p "$OUT"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  NODE="deno run --allow-read --allow-write"
fi

SUPP="${SUPP:-15}"
BIAS="${BIAS:-6}"
RISE="${RISE:-8}"

stats() {
  # $1 = file, $2 = label
  local s
  s=$(ffmpeg -hide_banner -i "$1" -af astats -f null - 2>&1 | grep -E "\] (RMS level|Peak level|Noise floor) dB" | tail -3)
  printf '%s\n%s\n' "$2" "$s"
}

band_rms() {
  # $1 = file, $2 = bandpass freq, $3 = width Hz -> RMS dB of that band
  ffmpeg -hide_banner -i "$1" -af "bandpass=f=$2:width_type=h:w=$3,astats" -f null - 2>&1 | grep "\] RMS level dB" | tail -1 | sed 's/.*dB: //'
}

for s in sampleA sampleB sampleC; do
  ffmpeg -hide_banner -loglevel error -y -i "$SAMPLES/$s.m4a" -c:a pcm_s16le "$OUT/$s-in.wav"
  $NODE "$HERE/denoise-file.mjs" "$OUT/$s-in.wav" "$OUT/$s-clean.wav" --max-suppression-db "$SUPP" --noise-bias-db "$BIAS" --noise-rise-sec "$RISE"
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/$s-clean.wav" -lavfi "showspectrumpic=s=1400x720:legend=1:scale=log:color=intensity" "$OUT/spec-$s-clean.png"
done

echo
stats "$OUT/sampleA-in.wav" "== sampleA before =="
stats "$OUT/sampleA-clean.wav" "== sampleA after  =="

# Synthetic validation lives in harness/test-dsp.mjs (sharp DFT measurements);
# ffmpeg's filters disagreed on synthetic mix files, so they are not used here.

echo
echo "spectrograms + wavs in $OUT"
