// Radix-2 Cooley-Tukey complex FFT. In-place, precomputed twiddles and
// bit-reversal table. No allocations after construction.

export class FFT {
  constructor(size) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.levels = Math.log2(size) | 0;

    const half = size / 2;
    this.cos = new Float32Array(half);
    this.sin = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      const angle = (2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(angle);
      this.sin[i] = Math.sin(angle);
    }

    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let j = 0; j < this.levels; j++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      this.rev[i] = r;
    }
  }

  /** Forward DFT (e^{-i...} twiddles), unnormalized. */
  forward(re, im) {
    this.transform(re, im, 1);
  }

  /** Inverse DFT, normalized by 1/size. */
  inverse(re, im) {
    this.transform(re, im, -1);
    const scale = 1 / this.size;
    for (let i = 0; i < this.size; i++) {
      re[i] *= scale;
      im[i] *= scale;
    }
  }

  // s = +1 forward, s = -1 inverse. Twiddle W = cos(2*pi*k/n) -/+ i*sin(2*pi*k/n).
  transform(re, im, s) {
    const n = this.size;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }

    const cos = this.cos;
    const sin = this.sin;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const wr = cos[k];
          const wi = sin[k];
          const ar = re[l];
          const ai = im[l];
          const tr = ar * wr + s * ai * wi;
          const ti = ai * wr - s * ar * wi;
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
  }
}
