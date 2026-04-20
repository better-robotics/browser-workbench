// Two-browser WebRTC pairing against signal.neevs.io with a transparent
// relay fallback. signal.neevs.io's server is an opaque JSON relay — it
// happens to double as a chat-grade transport when NAT traversal fails.
//
// Stage 1 shipped with P2P-only pairing: if ICE couldn't find a path
// (symmetric NAT, corporate WiFi, some carrier NATs), the data channel
// would never open and the pair would hang. Taking a cue from agora's
// remote flow, we now keep the signaling WebSocket open after the data
// channel opens, and fall back to routing {data:{relay:...}} frames
// through it when P2P isn't available. Motor control over relay is
// slower (~50-100ms vs ~5-10ms P2P) but chat doesn't care.
//
// Signal protocol (see ~/Github/jonasneves/signal/API.md):
//   connect wss://signal.neevs.io/{room}/ws
//   send   { type: "signal", peer: myRole, data: { offer|answer|ice|relay } }
//   recv   { type: "state",  peers: {...} }
//          { type: "signal", peer: theirRole, data: {...} }
const SIGNAL_WS_URL = "wss://signal.neevs.io";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

class Peer {
  constructor({ pc, channel, ws, myRole }) {
    this._pc = pc;
    this._channel = channel;
    this._ws = ws;
    this._myRole = myRole;
    this._onMessage = () => {};
    this._onClose = () => {};
    this._onTransportChange = () => {};
    let closedOnce = false;
    const dispatchClose = () => {
      if (closedOnce) return;
      closedOnce = true;
      this._onClose();
    };
    const dispatchTransport = () => this._onTransportChange(this.transport);

    // Forward-compat targeting: room-aware consumers (future N-peer rooms)
    // include an optional `to: "<peer-role-or-id>"` on outbound frames. If
    // set, receivers not matching their own role drop the frame silently.
    // Today's 1:1 flow never sets `to` — broadcasts reach the single peer —
    // so this is a no-op in production but lets future multi-peer code
    // filter without rework. Mirrors signal.neevs.io's own peer-routing key.
    const accept = (msg) => {
      if (msg && typeof msg === "object" && msg.to && msg.to !== this._myRole) return;
      this._onMessage(msg);
    };

    // P2P data channel: inbound JSON frames delivered straight to onMessage.
    channel.addEventListener("message", (e) => {
      try { accept(JSON.parse(e.data)); } catch {}
    });
    channel.addEventListener("close", () => {
      dispatchTransport();
      // Only fully close when BOTH transports are down.
      if (!this._ws || this._ws.readyState === WebSocket.CLOSED) dispatchClose();
    });

    // WS: carries signaling during negotiation (parent handles that) and
    // relay-wrapped payloads afterward. We read just the relay envelope here.
    ws.addEventListener("message", (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== "signal" || msg.peer === myRole) return;
      if (msg.data?.relay !== undefined) accept(msg.data.relay);
    });
    ws.addEventListener("close", () => {
      dispatchTransport();
      if (!this._channel || this._channel.readyState !== "open") dispatchClose();
    });

    // Only terminal PC states count as close. "disconnected" is transient
    // (momentary packet loss / brief ICE renegotiation) and recovers on its
    // own — treating it as a close made the card vanish on the first hiccup.
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        dispatchClose();
      }
    });
  }

  // "p2p" while the data channel is open, "relay" when only the WS survives,
  // "closed" when neither can carry a frame. Subscribe via onTransportChange.
  get transport() {
    if (this._channel?.readyState === "open") return "p2p";
    if (this._ws?.readyState === WebSocket.OPEN) return "relay";
    return "closed";
  }

  send(obj) {
    if (this._channel?.readyState === "open") {
      try { this._channel.send(JSON.stringify(obj)); return; } catch { /* fall through */ }
    }
    if (this._ws?.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify({
          type: "signal", peer: this._myRole, data: { relay: obj },
        }));
      } catch { /* nothing left to do */ }
    }
  }

  onMessage(cb)         { this._onMessage = cb; }
  onClose(cb)           { this._onClose = cb; }
  onTransportChange(cb) { this._onTransportChange = cb; }

  close() {
    try { this._channel?.close(); } catch {}
    try { this._pc.close(); } catch {}
    try { this._ws?.close(); } catch {}
  }
}

function openSignalWs(roomId) {
  return new WebSocket(`${SIGNAL_WS_URL}/${roomId}/ws`);
}

function wireIceTrickle(pc, ws, myRole) {
  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "signal", peer: myRole, data: { ice: e.candidate } }));
    }
  });
}

// Desktop: opens the room, waits for phone's offer, answers. Returns the
// Peer once EITHER the data channel opens (P2P) OR after a short grace
// period with just the WS alive (relay-only). WS stays open for the life
// of the Peer so relay fallback is always available.
//
// Grace timer starts when the FIRST signal from the phone arrives — not when
// hostPairingRoom was called. If the phone takes longer than the grace
// period to scan + connect, a function-start timer would fire uselessly and
// the promise would hang forever. Anchoring to "phone started signaling"
// fixes the long-pairing hang.
const P2P_WAIT_MS = 10000;

export function hostPairingRoom({ onStatus = () => {} } = {}) {
  const roomId = crypto.randomUUID();
  const myRole = "desktop";
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const ws = openSignalWs(roomId);
  wireIceTrickle(pc, ws, myRole);

  let incomingChannel = null;
  let graceTimer = null;
  let phoneHere = false;

  const peerPromise = new Promise((resolve, reject) => {
    const fail = (err) => { ws.close(); pc.close(); reject(err); };
    const resolveWithStub = (why) => {
      if (ws.readyState !== WebSocket.OPEN) return fail(new Error(`${why}, signal socket also closed`));
      onStatus(`p2p failed (${why}) — falling back to relay`);
      resolve(new Peer({ pc, channel: makeStubChannel(), ws, myRole }));
    };

    ws.addEventListener("open", () => onStatus("signal socket open"));

    pc.addEventListener("datachannel", (e) => {
      incomingChannel = e.channel;
      onStatus("data channel negotiating");
      e.channel.addEventListener("open", () => {
        onStatus("p2p connected");
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
        resolve(new Peer({ pc, channel: e.channel, ws, myRole }));
      });
    });

    ws.addEventListener("message", async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type !== "signal" || msg.peer === myRole) return;
      // Start the grace timer on first phone activity — if P2P doesn't open
      // within the window from here, fall back to relay. Ignoring signals
      // received before we've processed them means the timer can't fire while
      // the phone hasn't actually joined.
      if (!phoneHere) {
        phoneHere = true;
        onStatus("phone in room, negotiating");
        graceTimer = setTimeout(() => {
          if (incomingChannel?.readyState !== "open") resolveWithStub("p2p timeout");
        }, P2P_WAIT_MS);
      }
      if (msg.data?.offer) {
        await pc.setRemoteDescription(msg.data.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: "signal", peer: myRole, data: { answer } }));
      }
      if (msg.data?.ice) { try { await pc.addIceCandidate(msg.data.ice); } catch {} }
    });

    ws.addEventListener("error", () => fail(new Error("signal socket failed")));
    pc.addEventListener("connectionstatechange", () => {
      onStatus(`pc ${pc.connectionState}`);
      if (pc.connectionState === "failed"
          && phoneHere
          && incomingChannel?.readyState !== "open") {
        resolveWithStub("ice failed");
      }
    });
  });

  return {
    roomId,
    waitForPeer: () => peerPromise,
    cancel: () => { ws.close(); pc.close(); },
  };
}

// Phone: joins the room, creates the data channel + offer immediately,
// processes the desktop's answer. Grace timer starts when the desktop's
// answer arrives (proves the other side is live) — same anchoring as
// the host side to avoid firing before the counterpart is ready.
export function joinPairingRoom(roomId, { onStatus = () => {} } = {}) {
  const myRole = "phone";
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel("pip");
  const ws = openSignalWs(roomId);
  wireIceTrickle(pc, ws, myRole);

  return new Promise((resolve, reject) => {
    let resolved = false;
    let graceTimer = null;
    let desktopHere = false;
    const fail = (err) => { ws.close(); pc.close(); reject(err); };
    const finish = (ch) => {
      if (resolved) return;
      resolved = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolve(new Peer({ pc, channel: ch, ws, myRole }));
    };
    const finishRelay = (why) => {
      if (ws.readyState !== WebSocket.OPEN) return fail(new Error(`${why}, signal socket also closed`));
      onStatus(`p2p failed (${why}) — falling back to relay`);
      finish(makeStubChannel());
    };

    channel.addEventListener("open", () => {
      onStatus("p2p connected");
      finish(channel);
    });

    ws.addEventListener("open", async () => {
      onStatus("signal socket open, sending offer");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: "signal", peer: myRole, data: { offer } }));
    });

    ws.addEventListener("message", async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type !== "signal" || msg.peer === myRole) return;
      if (!desktopHere) {
        desktopHere = true;
        onStatus("desktop responding, negotiating");
        graceTimer = setTimeout(() => {
          if (!resolved) finishRelay("p2p timeout");
        }, P2P_WAIT_MS);
      }
      if (msg.data?.answer) await pc.setRemoteDescription(msg.data.answer);
      if (msg.data?.ice)   { try { await pc.addIceCandidate(msg.data.ice); } catch {} }
    });

    ws.addEventListener("error", () => fail(new Error("signal socket failed")));
    pc.addEventListener("connectionstatechange", () => {
      onStatus(`pc ${pc.connectionState}`);
      if (pc.connectionState === "failed" && !resolved) finishRelay("ice failed");
    });
  });
}

// A closed "data channel" stand-in. Peer checks readyState === "open" before
// sending over P2P; a stub that's always "closed" forces every send through
// the relay path without needing a conditional in Peer.send itself.
function makeStubChannel() {
  const listeners = {};
  return {
    readyState: "closed",
    send: () => {},
    close: () => {},
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
  };
}
