// Minimal RIFF/WAVE reader/writer for the harness. PCM16 and float32 only.

export function decodeWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(dv, 0) !== 'RIFF' || tag(dv, 8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  let pos = 12;
  while (pos + 8 <= dv.byteLength) {
    const id = tag(dv, pos);
    const size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: dv.getUint16(pos + 8, true),
        channels: dv.getUint16(pos + 10, true),
        sampleRate: dv.getUint32(pos + 12, true),
        bitsPerSample: dv.getUint16(pos + 22, true),
      };
    } else if (id === 'data') {
      dataOffset = pos + 8;
      dataSize = Math.min(size, dv.byteLength - dataOffset);
    }
    pos += 8 + size + (size & 1);
  }

  if (!fmt || dataOffset < 0) {
    throw new Error('missing fmt or data chunk');
  }

  const { audioFormat, channels, sampleRate, bitsPerSample } = fmt;
  const isFloat = audioFormat === 3;
  const isPcm = audioFormat === 1 && bitsPerSample === 16;
  if (!isFloat && !isPcm) {
    throw new Error(`unsupported WAV format: audioFormat=${audioFormat} bits=${bitsPerSample}`);
  }

  const bytesPerSample = bitsPerSample >> 3;
  const frames = Math.floor(dataSize / (bytesPerSample * channels));
  const out = [];
  for (let c = 0; c < channels; c++) {
    out.push(new Float32Array(frames));
  }
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const off = dataOffset + (f * channels + c) * bytesPerSample;
      out[c][f] = isFloat ? dv.getFloat32(off, true) : dv.getInt16(off, true) / 32768;
    }
  }
  return { sampleRate, channels: out, frames };
}

export function encodeWavPcm16(sampleRate, channels) {
  const frames = channels[0].length;
  const dataBytes = frames * channels.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const dv = new DataView(bytes.buffer);

  writeTag(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  writeTag(dv, 8, 'WAVE');
  writeTag(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels.length, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels.length * 2, true);
  dv.setUint16(32, channels.length * 2, true);
  dv.setUint16(34, 16, true);
  writeTag(dv, 36, 'data');
  dv.setUint32(40, dataBytes, true);

  let off = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels.length; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][f]));
      dv.setInt16(off, Math.round(v * 32767), true);
      off += 2;
    }
  }
  return bytes;
}

function tag(dv, offset) {
  return String.fromCharCode(
    dv.getUint8(offset),
    dv.getUint8(offset + 1),
    dv.getUint8(offset + 2),
    dv.getUint8(offset + 3),
  );
}

function writeTag(dv, offset, text) {
  for (let i = 0; i < 4; i++) {
    dv.setUint8(offset + i, text.charCodeAt(i));
  }
}
