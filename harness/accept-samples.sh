#!/usr/bin/env bash
# Canonical acceptance run: denoise the acceptance clips with shipping
# defaults, then assert the gates in accept.mjs. Deterministic end to end.
#
#   bash harness/accept-samples.sh && node harness/accept.mjs
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJ="$(cd "$HERE/../.." && pwd)"
OUT="$PROJ/out"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  NODE="deno run --allow-read --allow-write"
fi

$NODE "$HERE/denoise-file.mjs" "$OUT/sampleA-in.wav" "$OUT/accept-A.wav"
$NODE "$HERE/denoise-file.mjs" "$OUT/sampleB-in.wav" "$OUT/accept-B.wav"
$NODE "$HERE/denoise-file.mjs" "$PROJ/samples-brahms/brahms-theme.wav" "$OUT/accept-brahms.wav"
echo "acceptance wavs ready in $OUT"
