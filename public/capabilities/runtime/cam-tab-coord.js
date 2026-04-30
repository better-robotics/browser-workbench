// Same-origin tab coordination for the chip's single-PC WebRTC slot.
// ESP32 + libpeer hosts exactly one peer connection at a time. Without
// coordination, two dashboard tabs both try to open WebRTC, the second
// kicks the first via the chip's destroy+recreate path, and ICE-socket
// teardown bugs in libpeer make recovery flaky. Solution: only ONE tab
// per (origin, robot) maintains the WebRTC peer; other tabs subscribe
// for frames over BroadcastChannel and render the same video.
//
// Election: ping/pong on a per-robot channel. New tab pings; an
// existing primary replies pong. 200 ms of silence = no primary, claim
// it. Tab close announces "released" so a secondary can promote.
//
// Cross-profile (incognito) and cross-machine cases aren't covered —
// BroadcastChannel is same-origin same-profile only. Those scenarios
// fall through to the chip's first-window-wins behavior, which without
// the HTTP /stream fallback means the cross-profile secondary tab
// shows no video. That's a rare dev case.
export class CamTabCoordinator {
  constructor(entryId) {
    this._channel = new BroadcastChannel('br-cam-' + entryId);
    this._role = null;  // 'primary' | 'secondary'
    this._frameListeners = new Set();
    this._releaseListeners = new Set();
    this._channel.addEventListener('message', (e) => this._onMessage(e));
  }

  // Returns 'primary' or 'secondary'. Resolves within ~200 ms — fast
  // enough that the user doesn't see the delay between Start and video.
  claim() {
    return new Promise((resolve) => {
      let settled = false;
      const onPong = (e) => {
        if (settled) return;
        if (e.data?.type === 'pong') {
          settled = true;
          this._channel.removeEventListener('message', onPong);
          this._role = 'secondary';
          resolve('secondary');
        }
      };
      this._channel.addEventListener('message', onPong);
      this._channel.postMessage({ type: 'ping' });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        this._channel.removeEventListener('message', onPong);
        this._role = 'primary';
        resolve('primary');
      }, 200);
    });
  }

  _onMessage(e) {
    const d = e.data;
    if (!d) return;
    if (d.type === 'ping' && this._role === 'primary') {
      // New tab probing — let it know we have it.
      this._channel.postMessage({ type: 'pong' });
      return;
    }
    if (d.type === 'frame' && this._role === 'secondary') {
      for (const fn of this._frameListeners) { try { fn(d.bytes); } catch {} }
      return;
    }
    if (d.type === 'released' && this._role === 'secondary') {
      // Primary went away; consumer decides whether to re-claim
      // (typically by closing this coord and opening a new one).
      for (const fn of this._releaseListeners) { try { fn(); } catch {} }
    }
  }

  // Primary publishes each WebRTC video frame as a structured-clone
  // ArrayBuffer. ~5 KB per frame at 10 fps = 50 KB/s of intra-process
  // copy; trivial overhead vs the WebRTC decode path itself.
  broadcastFrame(bytes) {
    if (this._role !== 'primary') return;
    this._channel.postMessage({ type: 'frame', bytes });
  }

  onFrame(fn) { this._frameListeners.add(fn); return () => this._frameListeners.delete(fn); }
  onRelease(fn) { this._releaseListeners.add(fn); return () => this._releaseListeners.delete(fn); }

  release() {
    if (this._role === 'primary') {
      try { this._channel.postMessage({ type: 'released' }); } catch {}
    }
    try { this._channel.close(); } catch {}
    this._frameListeners.clear();
    this._releaseListeners.clear();
    this._role = null;
  }
}
