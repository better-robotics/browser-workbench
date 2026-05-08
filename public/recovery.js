// Works even when BLE is dead: the USB gadget runs under its own systemd unit
// (usb-gadget.service) independently of pi-robot.
import { $ } from "./dom.js";
import { log } from "./log.js";
import { mountTerminal } from "./xterm-host.js";

let _port = null;
let _reader = null;
let _writer = null;
let _readPump = null;
let _term = null;
let _fit = null;
let _resizeObs = null;

const ENCODER = new TextEncoder();

// state: "" (idle) | "connected" | "error" — drives dot color. text shown
// only when it carries info beyond the dot (e.g. error detail).
function setStatus(state, text = "") {
  $("recovery-status-dot").className = `dot${state ? ` ${state}` : ""}`;
  $("recovery-status").textContent = text;
}

// Pi USB-CDC gadget — fixed VID:PID set by usb-gadget-setup.sh on the
// Pi side (Linux Foundation / Multifunction Composite). Filtering on
// these makes sure that when both an ESP USB-UART and the Pi gadget
// are authorized in the same browser session, Pi mode auto-picks the
// Pi port and the picker only shows Pi devices.
const PI_GADGET_FILTERS = [{ usbVendorId: 0x1d6b, usbProductId: 0x0104 }];
function isPiGadget(port) {
  try {
    const { usbVendorId, usbProductId } = port.getInfo();
    return PI_GADGET_FILTERS.some(f =>
      f.usbVendorId === usbVendorId && f.usbProductId === usbProductId);
  } catch { return false; }
}
function pickKnownPi(ports) {
  return ports.find(isPiGadget) || null;
}

async function connect() {
  if (!("serial" in navigator)) {
    log("Web Serial not supported — use Chrome or Edge on desktop");
    setStatus("error", "unsupported browser");
    return;
  }
  // Skip picker when permission already granted (Chrome persists across
  // reloads) — but ONLY accept a port matching the Pi gadget's VID:PID,
  // otherwise an ESP USB-UART that was authorized for ESP mode would
  // silently steal Pi mode's connect.
  let known = [];
  try { known = await navigator.serial.getPorts(); } catch {}
  try {
    _port = pickKnownPi(known) || await navigator.serial.requestPort({ filters: PI_GADGET_FILTERS });
    // Two-attempt open: macOS sometimes fails the first open() right
    // after a prior disconnect (kernel /dev/cu.* not fully released);
    // and a SerialPort that came back already-open from a prior tab/page
    // session needs an explicit close() before the retry will take.
    try { await _port.open({ baudRate: 115200 }); }
    catch (err) {
      if (err.name === "InvalidStateError") {
        try { await _port.close(); } catch {}
      }
      await new Promise((r) => setTimeout(r, 200));
      await _port.open({ baudRate: 115200 });
    }
    try { await _port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
  } catch (err) {
    if (err.name !== "NotFoundError") log(`Recovery connect error: ${err.message}`);
    setStatus("");
    return;
  }
  setStatus("connected");
  $("recovery-connect").textContent = "Disconnect";

  ({ term: _term, fit: _fit, resizeObs: _resizeObs } = await mountTerminal($("recovery-term")));
  _term.focus();
  // Clear before any serial buffer flush — belt + suspenders alongside the
  // raf-deferred fit. Getty buffers from a prior session can flush into
  // xterm as leading blank lines right after the reader starts.
  _term.write("\x1b[2J\x1b[H");

  _term.onData(async (data) => {
    if (!_writer) return;
    try { await _writer.write(ENCODER.encode(data)); }
    catch (err) { _term?.writeln(`\r\n[write error: ${err.message}]`); }
  });

  _writer = _port.writable.getWriter();
  _reader = _port.readable.getReader();
  _readPump = (async () => {
    try {
      while (true) {
        const { value, done } = await _reader.read();
        if (done) break;
        if (value) _term?.write(value);
      }
    } catch (err) {
      _term?.writeln(`\r\n[read error: ${err.message}]`);
    }
  })();
}

async function disconnect() {
  // Release order matters: reader.cancel() resolves before the in-flight
  // read() promise settles, so releaseLock() must wait for the read pump
  // to actually exit — otherwise it throws "pending read", port.close()
  // then rejects with "stream is locked", and the port stays open. The
  // next port.open() fails with "port is already open" even though
  // the session looks gone.
  try { await _reader?.cancel(); } catch {}
  try { await _readPump; } catch {}
  try { _reader?.releaseLock(); } catch {}
  try { _writer?.releaseLock(); } catch {}
  try { await _port?.close(); } catch {}
  // Brief grace for the macOS kernel to release /dev/cu.usbserial-*.
  // Without this, an immediate flash-flow port.open() can still race.
  await new Promise((r) => setTimeout(r, 100));
  _reader = _writer = _readPump = _port = null;
  _resizeObs?.disconnect();
  _resizeObs = null;
  _fit?.dispose();
  _fit = null;
  _term?.dispose();
  _term = null;
  setStatus("");
  $("recovery-connect").textContent = "Connect";
}

// Lazy-loaded from app.js on first "Recovery" menu click; one-time setup
// guarded by the flag, dialog-open behavior on every call.
let _initialized = false;
export function init() {
  if (_initialized) return;
  _initialized = true;
  $("console-close").addEventListener("click", () => $("console-modal").close());
  $("recovery-connect").addEventListener("click", () => _port ? disconnect() : connect());
  // No outside-click dismiss — terminal session is real work; accidental
  // clicks outside the modal used to kill the connection and scrollback.
  // Explicit × button is the only way out.
  $("console-modal").addEventListener("close", () => { if (_port) disconnect(); });
}

// Tear down any active serial session held here. Idempotent — safe to
// call when nothing's open. Used by the global pre-flash cleanup so
// esp-web-tools' install button doesn't trip "port is already open".
export async function releasePort() { if (_port) await disconnect(); }
