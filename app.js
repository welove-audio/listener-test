"use strict";
// Listener test page: joins a LiveKit room with a subscribe token, plays the published Opus track in
// an <audio> element and measures what no ear can: command-to-ear latency (a pink-noise probe found
// by regularised GCC-PHAT, probe_xcorr.js), the connection type (TURN relay or direct), the
// received bitrate and the stereo difference L-R. Every measurement goes into an exportable JSON log.
//
// Provenance: the measurement structure follows production-tools/players/stream_transport_spike/page.html
// at commit c6eb008 (2026-09-11): both timestamps taken on the page's own clock (lines 37-40), the
// Web Audio tap on the received track (138-154), detection on the audio thread with a
// ScriptProcessor fallback for non-secure origins (96-131), arm -> POST -> detect (179-185).
// Changed here: livekit-client instead of the spike's own signalling, the GCC-PHAT probe detector
// instead of the 880 Hz Goertzel trigger, arrival mapped to the output clock, stats and export.

const URL_PARAMS = ["url", "token", "control", "relay", "min_psr"];
const LOG_SCHEMA = "aas-listener-log/1";
const PROBE_REF_URL = "probe_ref.wav";
const LIVEKIT_CLIENT_PIN = "2.23.0";
const DEFAULT_CONTROL = "http://127.0.0.1:8787";
const DETECT_INTERVAL_MS = 500;
const STATS_INTERVAL_MS = 1000;
const MEASURE_TIMEOUT_MS = 3000;
const SP_CHUNK = 1024;

const $ = (id) => document.getElementById(id);
const cfg = { ...ProbeXcorr.PROBE_DEFAULTS };
const records = [];
const meta = { room: null, identity: null, started_wall_ms: Date.now(), sample_rate: null, detector: null };
const S = { room: null, ctx: null, track: null, nodes: [], reference: null, refBuffer: null, ring: null,
  pending: null, armed: false, lastHitFrame: null, timers: [], prevInbound: null };

// ------------------------------------------------------------------ log
function record(kind, fields) {
  const rec = { t_ms: performance.now(), wall_ms: Date.now(), kind, ...fields };
  records.push(rec);
  return rec;
}

function logEvent(message) {
  record("event", { message });
  const el = $("log");
  el.textContent += `${new Date().toISOString().slice(11, 23)}  ${message}\n`;
  el.scrollTop = el.scrollHeight;
}

const fmt = (x, digits = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(digits));

function jwtClaims(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "=")));
    return { identity: claims.sub ?? null, room: claims.video?.room ?? null };
  } catch {
    return { identity: null, room: null };
  }
}

// ------------------------------------------------------------------ ring buffer of mono samples
class Ring {
  constructor(size) { this.buf = new Float32Array(size); this.size = size; this.pos = 0; this.count = 0; this.end = null; }

  write(x) {
    for (let i = 0; i < x.length; i++) {
      this.buf[this.pos] = x[i];
      this.pos = (this.pos + 1) % this.size;
    }
    this.count = Math.min(this.size, this.count + x.length);
  }

  push(startFrame, samples) {
    if (this.end !== null && Math.abs(startFrame - this.end) <= 2) startFrame = this.end;  // rounding jitter
    if (this.end !== null && startFrame > this.end) this.write(new Float32Array(Math.min(startFrame - this.end, this.size)));
    this.write(samples);
    this.end = startFrame + samples.length;
  }

  last(n) {  // {start: absolute frame of data[0], data} or null while too short
    if (this.count < n) return null;
    const data = new Float32Array(n);
    const from = (this.pos - n + this.size) % this.size;
    for (let i = 0; i < n; i++) data[i] = this.buf[(from + i) % this.size];
    return { start: this.end - n, data };
  }
}

// ------------------------------------------------------------------ tap messages
function onLevel(msg) {
  $("stereo").textContent = `L-R rms ${fmt(msg.lr_rms, 4)} / L+R rms ${fmt(msg.sum_rms, 4)} (${msg.channels} ch)`;
  record("level", { lr_rms: msg.lr_rms, sum_rms: msg.sum_rms, channels: msg.channels });
}

function onTapMessage(msg) {
  if (msg.type === "audio") S.ring.push(msg.startFrame, msg.samples);
  else if (msg.type === "level") onLevel(msg);
}

function scriptProcessorTap(ctx) {  // same messages as probe_capture.js, for non-secure origins
  const sp = ctx.createScriptProcessor(SP_CHUNK, 2, 1);
  const every = Math.round(0.25 * ctx.sampleRate);
  let lr = 0, sum = 0, count = 0;
  sp.onaudioprocess = (e) => {
    const input = e.inputBuffer, channels = input.numberOfChannels;
    const left = input.getChannelData(0), right = channels > 1 ? input.getChannelData(1) : left;
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      mono[i] = channels > 1 ? 0.5 * (left[i] + right[i]) : left[i];
      lr += (left[i] - right[i]) ** 2;
      sum += (left[i] + right[i]) ** 2;
      count++;
    }
    // playbackTime is the output time of this buffer; its input was captured at least one buffer
    // earlier (often two), so subtract one buffer and mark the hits "approx" (frameToPerf).
    const startFrame = Math.round(e.playbackTime * ctx.sampleRate) - SP_CHUNK;
    onTapMessage({ type: "audio", startFrame, samples: mono });
    if (count >= every) {
      onTapMessage({ type: "level", lr_rms: Math.sqrt(lr / count), sum_rms: Math.sqrt(sum / count), channels });
      lr = sum = count = 0;
    }
  };
  return sp;
}

// ------------------------------------------------------------------ audio graph
async function onTrackSubscribed(track) {
  if (track.kind !== "audio") return;
  logEvent("trackSubscribed (audio)");
  if (S.ctx) teardownAudio();  // a second subscription replaces the first graph and its timers
  track.attach($("player"));  // the audible path, as the real clients play it
  const ctx = new AudioContext();
  S.ctx = ctx;
  S.track = track;
  meta.sample_rate = ctx.sampleRate;
  logEvent(`AudioContext created: state ${ctx.state}`);
  ctx.onstatechange = () => { if (S.ctx === ctx) showContextState(ctx); };
  const current = () => S.ctx === ctx;  // false once torn down or replaced while awaiting
  const reference = (await ctx.decodeAudioData(S.refBuffer.slice(0))).getChannelData(0);  // at ctx.sampleRate
  if (!current()) return;
  S.reference = reference;
  S.ring = new Ring(Math.ceil((cfg.window_s + 1) * ctx.sampleRate));
  const src = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
  let tap;
  if (ctx.audioWorklet) {
    await ctx.audioWorklet.addModule("probe_capture.js");
    if (!current()) return;
    tap = new AudioWorkletNode(ctx, "probe-capture", { numberOfInputs: 1, numberOfOutputs: 1 });
    tap.port.onmessage = (e) => onTapMessage(e.data);
    meta.detector = "worklet";
    $("detector").textContent = "AudioWorklet";
  } else {
    tap = scriptProcessorTap(ctx);
    meta.detector = "scriptprocessor";
    $("detector").textContent = "ScriptProcessor (non-secure origin)";
  }
  const mute = ctx.createGain();
  mute.gain.value = 0;  // the graph is pulled but silent: the <audio> element carries the sound
  src.connect(tap);
  tap.connect(mute);
  mute.connect(ctx.destination);
  S.nodes = [src, tap, mute];
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  if (!current()) return;
  showContextState(ctx);
  logEvent(`AudioContext ${ctx.sampleRate} Hz, reference ${S.reference.length} samples, tap: ${$("detector").textContent}`);
  S.timers.push(setInterval(detectTick, DETECT_INTERVAL_MS), setInterval(() => statsTick().catch((err) => logEvent(`stats failed: ${err}`)), STATS_INTERVAL_MS));
  for (const id of ["probe", "beep", "arm"]) $(id).disabled = false;
}

function showContextState(ctx) {  // a suspended context never runs the tap: say so, offer Start audio
  logEvent(`AudioContext state: ${ctx.state}`);
  if (ctx.state === "suspended") {
    $("detector").textContent = `${meta.detector ?? "tap"}: AudioContext suspended, press Start audio`;
    $("startaudio").hidden = false;
  } else if (ctx.state === "running") {
    if (S.nodes.length) $("detector").textContent = meta.detector === "worklet" ? "AudioWorklet" : "ScriptProcessor (non-secure origin)";
    if (S.room?.canPlaybackAudio) $("startaudio").hidden = true;
  }
}

function teardownAudio() {
  S.timers.forEach(clearInterval);
  S.timers = [];
  for (const node of S.nodes) node.disconnect();
  S.nodes = [];
  if (S.track) S.track.detach();
  if (S.ctx) S.ctx.close().catch(() => {});
  Object.assign(S, { ctx: null, track: null, ring: null, reference: null, pending: null, lastHitFrame: null, prevInbound: null });
  for (const id of ["probe", "beep", "arm"]) $(id).disabled = true;
  for (const id of ["latency", "publisher_to_ear", "psr", "connection", "bitrate", "stereo", "detector"]) $(id).textContent = "-";
}

// ------------------------------------------------------------------ detection
function frameToPerf(frame) {  // performance.now() time at which context frame `frame` is played out
  const ctx = S.ctx;
  const ts = typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : null;
  if (ts && ts.performanceTime > 0) {
    // the ScriptProcessor's frame numbers carry an unknown extra buffer of input delay
    const timing = meta.detector === "worklet" ? "output_timestamp" : "approx";
    return { perf: ts.performanceTime + (frame / ctx.sampleRate - ts.contextTime) * 1000, timing };
  }
  return { perf: performance.now() + (frame / ctx.sampleRate - ctx.currentTime) * 1000, timing: "approx" };
}

function expirePending() {
  if (S.pending && performance.now() - S.pending.t0 > MEASURE_TIMEOUT_MS) {
    record("probe", { trigger: "page", latency_ms: null, sent_at: S.pending.sent_at, heard_wall_ms: null,
      publisher_to_ear_ms: null, peak: null, psr: null, detected: false, timing: null });
    $("latency").textContent = "not detected";
    logEvent("probe not detected within 3 s");
    S.pending = null;
  }
}

function detectTick() {
  if (!S.ctx || !S.ring || (!S.pending && !S.armed)) return;
  const win = S.ring.last(Math.round(cfg.window_s * S.ctx.sampleRate));
  if (win) {
    const hit = ProbeXcorr.findProbe(win.data, S.reference, S.ctx.sampleRate, cfg);
    const frame = win.start + hit.lag_samples;
    const fresh = S.lastHitFrame === null || frame - S.lastHitFrame > cfg.refractory_s * S.ctx.sampleRate;
    if (hit.detected && fresh) {
      const { perf, timing } = frameToPerf(frame);
      if (onHit(hit, perf, Math.round(Date.now() - (performance.now() - perf)), timing)) S.lastHitFrame = frame;
    }
  }
  expirePending();
}

function onHit(hit, arrivalPerf, heardWall, timing) {  // true when the hit was recorded
  const base = { heard_wall_ms: heardWall, peak: hit.peak, psr: hit.psr, detected: true, timing };
  if (S.pending && arrivalPerf > S.pending.t0) {
    const latency = arrivalPerf - S.pending.t0;
    const sentAt = S.pending.sent_at;
    const p2e = sentAt === null ? null : heardWall - sentAt;
    record("probe", { trigger: "page", latency_ms: latency, sent_at: sentAt, publisher_to_ear_ms: p2e, ...base });
    $("latency").textContent = `${fmt(latency)} ms${timing === "approx" ? " (approx)" : ""}`;
    $("publisher_to_ear").textContent = p2e === null ? "-" : `${fmt(p2e)} ms`;
    $("psr").textContent = fmt(hit.psr);
    logEvent(`probe heard: ${fmt(latency)} ms after the click, PSR ${fmt(hit.psr)}, peak ${fmt(hit.peak, 3)}`);
    S.pending = null;
    return true;
  }
  if (S.armed) {
    record("probe", { trigger: "remote", latency_ms: null, sent_at: null, publisher_to_ear_ms: null, ...base });
    $("psr").textContent = fmt(hit.psr);
    logEvent(`remote probe heard at wall ${heardWall} ms, PSR ${fmt(hit.psr)}`);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ stats
function selectedPair(byId) {
  for (const s of byId.values()) {
    if (s.type === "transport" && s.selectedCandidatePairId && byId.has(s.selectedCandidatePairId)) return byId.get(s.selectedCandidatePairId);
  }
  for (const s of byId.values()) {  // Firefox: no transport entry
    if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") return s;
  }
  return null;
}

async function statsTick() {
  if (!S.track) return;
  const report = await S.track.getRTCStatsReport();
  if (!report) return;
  const byId = new Map();
  report.forEach((s) => byId.set(s.id, s));
  const pair = selectedPair(byId);
  const local = pair ? byId.get(pair.localCandidateId) : null, remote = pair ? byId.get(pair.remoteCandidateId) : null;
  const relay = local?.candidateType === "relay" || remote?.candidateType === "relay";
  const connection = !pair ? "unknown" : relay ? "relay" : "direct";
  const inbound = [...byId.values()].find((s) => s.type === "inbound-rtp" && s.kind === "audio");
  if (!inbound) return;
  const codec = inbound.codecId ? byId.get(inbound.codecId) : null;
  const headerBytes = typeof inbound.headerBytesReceived === "number";
  const wireBytes = inbound.bytesReceived + (headerBytes ? inbound.headerBytesReceived : 0);
  const prev = S.prevInbound;
  const dt = prev ? inbound.timestamp - prev.timestamp : 0;
  const payloadKbps = dt > 0 ? ((inbound.bytesReceived - prev.bytes) * 8) / dt : null;
  const wireKbps = dt > 0 ? ((wireBytes - prev.wire) * 8) / dt : null;
  S.prevInbound = { timestamp: inbound.timestamp, bytes: inbound.bytesReceived, wire: wireBytes };
  record("stats", {
    connection, local_candidate: local?.candidateType ?? null, remote_candidate: remote?.candidateType ?? null,
    protocol: local?.protocol ?? null, relay_protocol: local?.relayProtocol ?? null, payload_kbps: payloadKbps,
    wire_kbps: wireKbps, header_bytes: headerBytes, packets_lost: inbound.packetsLost ?? 0,
    jitter_ms: (inbound.jitter ?? 0) * 1000, concealed_samples: inbound.concealedSamples ?? null,
    codec: codec?.mimeType ?? null, channels: codec?.channels ?? null, sdp_fmtp: codec?.sdpFmtpLine ?? null,
  });
  $("connection").textContent = `${connection} (${local?.candidateType ?? "?"} / ${remote?.candidateType ?? "?"}, ${local?.protocol ?? "?"})`;
  $("bitrate").textContent = `payload ${fmt(payloadKbps)} / wire ${fmt(wireKbps)} kbit/s, ${codec?.mimeType ?? "?"} ${codec?.sdpFmtpLine ?? ""}`;
}

// ------------------------------------------------------------------ buttons
async function post(path) {
  const base = $("control").value.trim().replace(/\/+$/, "");
  const resp = await fetch(`${base}${path}`, { method: "POST" });
  return resp.json();
}

async function measure() {
  const t0 = performance.now();
  S.pending = { t0, sent_at: null };
  $("latency").textContent = "listening...";
  try {
    const body = await post("/probe");
    if (body.event !== "probe") throw new Error(body.message ?? JSON.stringify(body));
    if (S.pending && S.pending.t0 === t0) S.pending.sent_at = body.sent_at;
    logEvent(`probe sent (n ${body.n}, frame ${body.frame})`);
  } catch (err) {
    logEvent(`probe POST failed: ${err}`);
    if (S.pending && S.pending.t0 === t0) S.pending = null;
    $("latency").textContent = "-";
  }
}

async function connect() {
  const url = $("url").value.trim(), token = $("token").value.trim();
  if (!url || !token) return logEvent("LiveKit URL and token are required");
  if (typeof LivekitClient === "undefined") return logEvent("livekit-client is not loaded (CDN unreachable or SRI mismatch)");
  if (!S.refBuffer) return logEvent(`${PROBE_REF_URL} is not loaded`);
  Object.assign(meta, jwtClaims(token));
  const LK = LivekitClient;
  const room = new LK.Room({ adaptiveStream: false, dynacast: false });
  S.room = room;
  room
    .on(LK.RoomEvent.ConnectionStateChanged, (state) => { $("state").textContent = state; logEvent(`state: ${state}`); })
    .on(LK.RoomEvent.TrackSubscribed, (track) => onTrackSubscribed(track).catch((err) => logEvent(`audio tap failed: ${err}`)))
    .on(LK.RoomEvent.TrackUnsubscribed, (track) => { logEvent("trackUnsubscribed"); if (track === S.track) teardownAudio(); })
    .on(LK.RoomEvent.Disconnected, () => { logEvent("disconnected"); teardownAudio(); $("connect").disabled = false; $("disconnect").disabled = true; })
    .on(LK.RoomEvent.AudioPlaybackStatusChanged, () => { $("startaudio").hidden = room.canPlaybackAudio; });
  const relay = $("relay").checked;
  $("connect").disabled = true;
  try {
    await room.connect(url, $("token").value.trim(), relay ? { rtcConfig: { iceTransportPolicy: "relay" } } : undefined);
    logEvent(`connected: room ${meta.room ?? room.name}, identity ${meta.identity}${relay ? ", relay forced" : ""}`);
    $("disconnect").disabled = false;
  } catch (err) {
    logEvent(`connect failed: ${err.message ?? err}`);
    $("connect").disabled = false;
  }
}

function exportLog() {
  const doc = {
    schema: LOG_SCHEMA, livekit_client: livekitVersion(), user_agent: navigator.userAgent, origin: location.origin,
    secure_context: window.isSecureContext, detector: meta.detector, room: meta.room, identity: meta.identity,
    started_wall_ms: meta.started_wall_ms, sample_rate: meta.sample_rate, records,
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" }));
  a.download = `listener-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const livekitVersion = () => (typeof LivekitClient !== "undefined" && LivekitClient.version) || LIVEKIT_CLIENT_PIN;

// ------------------------------------------------------------------ start-up
function init() {
  const params = new URLSearchParams(location.search);
  for (const name of URL_PARAMS) {
    const value = params.get(name);
    if (value === null) continue;
    if (name === "relay") $("relay").checked = value === "1";
    else if (name === "min_psr") cfg.min_psr = Number(value) || cfg.min_psr;
    else $(name).value = value;
  }
  if (!$("control").value) $("control").value = DEFAULT_CONTROL;
  $("connect").onclick = () => connect();
  $("disconnect").onclick = () => S.room?.disconnect();
  $("startaudio").onclick = () => {  // inside the click: both may need a user gesture
    S.ctx?.resume().catch((err) => logEvent(`AudioContext resume failed: ${err}`));
    S.room?.startAudio().then(() => { if (S.ctx?.state !== "suspended") $("startaudio").hidden = true; },
      (err) => logEvent(`startAudio failed: ${err}`));
  };
  $("probe").onclick = () => measure();
  $("beep").onclick = () => post("/beep").then(() => logEvent("beep sent"), (err) => logEvent(`beep POST failed: ${err}`));
  $("arm").onclick = () => {
    S.armed = !S.armed;
    $("arm").textContent = S.armed ? "Disarm" : "Arm (record remote probes)";
    logEvent(S.armed ? "armed" : "disarmed");
  };
  $("export").onclick = exportLog;
  logEvent(`secure context: ${window.isSecureContext}`);
  logEvent(`AudioWorklet: ${typeof AudioWorkletNode === "function" && window.isSecureContext ? "available" : "not available"}`);
  logEvent(typeof LivekitClient === "undefined" ? "livekit-client: NOT LOADED" : `livekit-client ${livekitVersion()}`);
  logEvent(`detector: min_psr ${cfg.min_psr}, min_peak ${cfg.min_peak}, window ${cfg.window_s} s`);
  fetch(PROBE_REF_URL)
    .then((resp) => { if (!resp.ok) throw new Error(`HTTP ${resp.status}`); return resp.arrayBuffer(); })
    .then(async (buf) => {
      S.refBuffer = buf;
      const probe = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(buf.slice(0));
      logEvent(`reference: ${probe.length} samples`);
    })
    .catch((err) => logEvent(`reference ${PROBE_REF_URL} not loaded: ${err}`));
}

init();
