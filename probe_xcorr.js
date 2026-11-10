"use strict";
// Probe detector of the listener page: regularised GCC-PHAT of a window of received audio against
// the probe reference. JavaScript twin of aas/listener/probe_detect.py: the same formula, the same
// constants (PROBE_DEFAULTS, SILENCE_RMS) and the same peak / PSR / detected rules, so the page's
// numbers can be cross-checked with `python -m aas.listener detect` over an offline render.
//
//   X = FFT(w, N) * conj(FFT(r, N)),  N = smallest power of two >= Lw + M - 1
//   c = IFFT(X / (|X| + eps * mean|X|))[0 .. Lw - M]   (mean over bins 0..N/2, as numpy's rfft)
//   lag = argmax |c|, peak = |c[lag]|, psr = peak / rms(|c| outside lag +- round(guard_s * rate))

const PROBE_DEFAULTS = {"window_s": 2.0, "guard_s": 0.005, "min_peak": 0.03, "min_psr": 8.0, "refractory_s": 1.0, "phat_eps": 0.001};
const SILENCE_RMS = 1e-4;

const twiddleCache = new Map();

function twiddles(n) {
  let t = twiddleCache.get(n);
  if (!t) {
    t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
    for (let k = 0; k < n / 2; k++) {
      t.cos[k] = Math.cos((-2 * Math.PI * k) / n);
      t.sin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
    twiddleCache.set(n, t);
  }
  return t;
}

// In-place iterative radix-2 complex FFT (forward, no scaling); re.length must be a power of two.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const tw = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const wr = tw.cos[k * step], wi = tw.sin[k * step];
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

function nextPow2(x) {
  let n = 1;
  while (n < x) n *= 2;
  return n;
}

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return x.length ? Math.sqrt(s / x.length) : 0;
}

// Python's round(): halves to even, so the guard matches the twin at every sample rate.
function roundHalfEven(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// Regularised GCC-PHAT; returns the Float64Array c of length Lw - M + 1.
function gccPhat(window, reference, eps = PROBE_DEFAULTS.phat_eps) {
  const lw = window.length, m = reference.length;
  if (lw < m) throw new RangeError(`window (${lw} samples) is shorter than the reference (${m} samples)`);
  const n = nextPow2(lw + m - 1);
  const wr = new Float64Array(n), wi = new Float64Array(n);
  const rr = new Float64Array(n), ri = new Float64Array(n);
  wr.set(window);
  rr.set(reference);
  fft(wr, wi);
  fft(rr, ri);
  let magSum = 0;
  for (let k = 0; k < n; k++) {
    const xr = wr[k] * rr[k] + wi[k] * ri[k];   // W * conj(R)
    const xi = wi[k] * rr[k] - wr[k] * ri[k];
    wr[k] = xr;
    wi[k] = xi;
    if (k <= n / 2) magSum += Math.hypot(xr, xi);
  }
  const floor = eps * (magSum / (n / 2 + 1));
  for (let k = 0; k < n; k++) {
    const denom = Math.hypot(wr[k], wi[k]) + floor;
    // inverse FFT via conj(FFT(conj(Y))) / n: store conj(Y) here
    wr[k] = denom > 0 ? wr[k] / denom : 0;
    wi[k] = denom > 0 ? -wi[k] / denom : 0;
  }
  fft(wr, wi);
  const c = new Float64Array(lw - m + 1);
  for (let i = 0; i < c.length; i++) c[i] = wr[i] / n;
  return c;
}

// Strongest correlation peak of `window`; a silent window is not correlated (silence guard).
function findProbe(window, reference, sampleRate, cfg = {}) {
  const p = { ...PROBE_DEFAULTS, ...cfg };
  if (rms(window) < SILENCE_RMS) return { lag_samples: 0, lag_s: 0, peak: 0, psr: 0, detected: false };
  const c = gccPhat(window, reference, p.phat_eps);
  let lag = 0, peak = -1;
  for (let i = 0; i < c.length; i++) {
    const a = Math.abs(c[i]);
    if (a > peak) { peak = a; lag = i; }
  }
  const guard = roundHalfEven(p.guard_s * sampleRate);
  let s = 0, count = 0;
  for (let i = 0; i < c.length; i++) {
    if (i >= lag - guard && i <= lag + guard) continue;
    s += c[i] * c[i];
    count++;
  }
  const side = count ? Math.sqrt(s / count) : 0;
  const psr = side > 0 ? peak / side : Infinity;
  return { lag_samples: lag, lag_s: lag / sampleRate, peak, psr, detected: peak >= p.min_peak && psr >= p.min_psr };
}

globalThis.ProbeXcorr = { PROBE_DEFAULTS, SILENCE_RMS, fft, gccPhat, findProbe };
