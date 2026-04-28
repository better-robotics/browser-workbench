// Browser ↔ Pi WebRTC peer manager.
//
// Wire format (single round-trip, no trickle ICE):
//   POST http://<robot-host>:82/webrtc/offer
//        Content-Type: application/json
//        body: { sdp: "<full SDP including all gathered ICE candidates>" }
//   →   200 application/json
//        body: { sdp: "<Pi's answer SDP including its candidates>" }
//   The Pi must support PNA preflight (Access-Control-Allow-Private-Network)
//   on this endpoint, same way pi_robot_health.py handles /health on :81.
//
// Why non-trickle: LAN-direct, no TURN, ICE candidates are stable host
// candidates, gathering completes in <1 s. Single HTTP round-trip is cleaner
// than trickling through a separate signaling channel.
//
// Channels are labeled byte streams. Phase 1.A uses one: "shell". Future
// phases add "ota", "logs", "telemetry" — each is a peer.createDataChannel()
// not a new daemon/port.

import { freshUrl } from "./dom.js";

// Per-robot peer connections, lazy-built. Keyed by robot id (state.devices key).
const _peers = new Map();  // robotId → { pc, channels: Map<label, RTCDataChannel>, host }

// Resolve the robot's hostname → URL base. Mirrors how the dashboard
// already probes <host>.local:81/health.
function rtcUrl(host) {
  return `http://${host}:82/webrtc/offer`;
}

// Open (or reuse) a peer connection to the robot, then ensure a DataChannel
// with the requested label exists and is open. Resolves to the open channel.
//
// The PC is reused across channels — one peer connection per robot, many
// labeled channels. Subsequent calls with new labels add channels to the
// existing PC (re-negotiation handled inline).
export async function openChannel(robotId, host, label, options = {}) {
  let entry = _peers.get(robotId);
  if (!entry) {
    entry = { pc: null, channels: new Map(), host };
    _peers.set(robotId, entry);
  }
  // If a channel with the same label is open, reuse it.
  const existing = entry.channels.get(label);
  if (existing && existing.readyState === "open") return existing;

  // First channel: do the SDP handshake. Subsequent channels could in
  // principle re-negotiate, but Phase 1.A is single-channel — one handshake
  // per peer connection lifetime.
  if (!entry.pc) {
    entry.pc = new RTCPeerConnection({
      // STUN unnecessary for LAN-direct host candidates; no TURN needed.
      iceServers: [],
    });
    entry.pc.addEventListener("connectionstatechange", () => {
      const s = entry.pc.connectionState;
      if (s === "failed" || s === "closed" || s === "disconnected") {
        for (const ch of entry.channels.values()) try { ch.close(); } catch {}
        entry.channels.clear();
        try { entry.pc.close(); } catch {}
        _peers.delete(robotId);
      }
    });
  }

  const channel = entry.pc.createDataChannel(label, {
    ordered: options.ordered !== false,  // ordered by default (shell needs it)
  });
  entry.channels.set(label, channel);

  // Build offer, wait for ICE gathering to complete, then post.
  const offer = await entry.pc.createOffer();
  await entry.pc.setLocalDescription(offer);
  await waitForIceComplete(entry.pc, options.iceTimeoutMs ?? 3000);

  const res = await fetch(freshUrl(rtcUrl(host)), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sdp: entry.pc.localDescription.sdp }),
  });
  if (!res.ok) {
    try { entry.pc.close(); } catch {}
    _peers.delete(robotId);
    throw new Error(`signaling ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const { sdp } = await res.json();
  await entry.pc.setRemoteDescription({ type: "answer", sdp });

  // Channel "open" event resolves once SCTP is up.
  if (channel.readyState !== "open") {
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onErr = (e) => { cleanup(); reject(new Error("channel error")); };
      const onClose = () => { cleanup(); reject(new Error("channel closed before open")); };
      const cleanup = () => {
        channel.removeEventListener("open", onOpen);
        channel.removeEventListener("error", onErr);
        channel.removeEventListener("close", onClose);
      };
      channel.addEventListener("open", onOpen);
      channel.addEventListener("error", onErr);
      channel.addEventListener("close", onClose);
    });
  }
  return channel;
}

// Close a peer connection and all its channels. Used by the dialog on close,
// or by the robot disconnect path.
export function closePeer(robotId) {
  const entry = _peers.get(robotId);
  if (!entry) return;
  for (const ch of entry.channels.values()) try { ch.close(); } catch {}
  try { entry.pc?.close(); } catch {}
  _peers.delete(robotId);
}

// Wait for the PC to finish gathering ICE candidates so the SDP we POST
// includes all host candidates. Resolves on `iceGatheringState === "complete"`
// or after a timeout (whichever first — slow networks shouldn't block forever).
function waitForIceComplete(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
