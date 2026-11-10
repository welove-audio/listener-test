"use strict";
// AudioWorklet tap of the listener page (loaded with audioWorklet.addModule): forwards the received
// audio to the page in 1024-sample mono chunks (the channel mean for stereo input) tagged with the
// context frame of their first sample, and reports the stereo difference every 250 ms as the rms
// of L-R and L+R (a mono input counts as L == R: L-R is 0, L+R is twice the signal).

const CHUNK = 1024;

class ProbeCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(CHUNK);
    this.fill = 0;
    this.chunkStart = 0;
    this.levelEvery = Math.round(0.25 * sampleRate);
    this.lr = 0;
    this.sum = 0;
    this.count = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    const right = input.length > 1 ? input[1] : null;
    for (let i = 0; i < left.length; i++) {
      if (this.fill === 0) this.chunkStart = currentFrame + i;
      const l = left[i], r = right ? right[i] : left[i];
      this.chunk[this.fill++] = right ? 0.5 * (l + r) : l;
      this.lr += (l - r) * (l - r);
      this.sum += (l + r) * (l + r);
      this.count++;
      if (this.fill === CHUNK) {
        this.port.postMessage({ type: "audio", startFrame: this.chunkStart, samples: this.chunk }, [this.chunk.buffer]);
        this.chunk = new Float32Array(CHUNK);
        this.fill = 0;
      }
      if (this.count >= this.levelEvery) {
        this.port.postMessage({
          type: "level", lr_rms: Math.sqrt(this.lr / this.count), sum_rms: Math.sqrt(this.sum / this.count),
          channels: input.length,
        });
        this.lr = this.sum = this.count = 0;
      }
    }
    return true;
  }
}

registerProcessor("probe-capture", ProbeCapture);
