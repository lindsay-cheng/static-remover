#!/usr/bin/env bash
# Preset sweep: score gentler configs on static removal AND music
# preservation (the muffle meter). zsh-safe (no word splitting).
#
#   bash harness/preset-sweep.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJ="$(cd "$HERE/../.." && pwd)"
OUT="$PROJ/audio/outputs"
SWEEP="$OUT/sweep"
mkdir -p "$SWEEP"

for spec in "1.0 3 12" "1.2 4 12" "1.5 6 12" "1.5 6 18" "1.0 6 12" "2.0 9 18"; do
  echo "$spec" | while read -r A B C; do
    tag="a${A}-b${B}-c${C}"
    node "$HERE/denoise-file.mjs" "$OUT/sampleA-in.wav" "$SWEEP/sampleA-$tag.wav" \
      --alpha "$A" --noise-bias-db "$B" --max-suppression-db "$C" --noise-rise-sec 8 > /dev/null
    node "$HERE/denoise-file.mjs" "$OUT/sampleB-in.wav" "$SWEEP/sampleB-$tag.wav" \
      --alpha "$A" --noise-bias-db "$B" --max-suppression-db "$C" --noise-rise-sec 8 > /dev/null
    echo "===== preset $tag (alpha=$A bias=${B}dB cap=${C}dB) ====="
    echo "--- sampleA quiet, static cut (2-14s) ---"
    node "$HERE/quality.mjs" "$OUT/sampleA-in.wav" "$SWEEP/sampleA-$tag.wav" 2 14 | grep -E "static band|high band|centroid"
    echo "--- sampleA music preservation (40-110s) ---"
    node "$HERE/quality.mjs" "$OUT/sampleA-in.wav" "$SWEEP/sampleA-$tag.wav" 40 110 | grep -E "high band|centroid|crest"
    echo "--- sampleB full (music preservation) ---"
    node "$HERE/quality.mjs" "$OUT/sampleB-in.wav" "$SWEEP/sampleB-$tag.wav" | grep -E "high band|centroid|crest"
    echo
  done
done
