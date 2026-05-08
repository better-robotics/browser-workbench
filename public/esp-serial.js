// ESP32 USB serial console + flash. Companion to recovery.js (Pi USB-CDC);
// shares xterm.js + Web Serial primitives via xterm-host.js.
import { $ } from "./dom.js";
import { log } from "./log.js";
import { mountTerminal } from "./xterm-host.js";

let _wired = false;
let _port = null;
let _reader = null;
let _writer = null;
let _readPump = null;
let _term = null;
let _fit = null;
let _resizeObs = null;

const ENCODER = new TextEncoder();

// state: "" (idle/disconnected) | "connected" | "connecting" | "error".
// Drives the dot color; text only renders for non-default detail messages.
function setStatus(state, text = "") {
  const dot = $("esp-serial-status-dot");
  const el = $("esp-serial-status");
  if (dot) dot.className = `dot${state ? ` ${state}` : ""}`;
  if (el) el.textContent = text;
}

const LAST_PORT_KEY = "esp-serial-last-port";
function rememberPort(port) {
  try {
    const i = port.getInfo();
    if (i.usbVendorId && i.usbProductId) {
      localStorage.setItem(LAST_PORT_KEY, `${i.usbVendorId}:${i.usbProductId}`);
    }
  } catch {}
}
function pickKnown(ports) {
  if (ports.length <= 1) return ports[0] || null;
  let last = "";
  try { last = localStorage.getItem(LAST_PORT_KEY) || ""; } catch {}
  if (last) {
    for (const p of ports) {
      try {
        const i = p.getInfo();
        if (`${i.usbVendorId}:${i.usbProductId}` === last) return p;
      } catch {}
    }
  }
  return ports[0];
}
async function pickOrRequestPort() {
  let known = [];
  try { known = await navigator.serial.getPorts(); } catch {}
  if (known.length >= 1) return pickKnown(known);
  return await navigator.serial.requestPort();
}
// Two-attempt open: macOS occasionally fails the first open() right after
// a previous disconnect because the kernel hasn't fully released the
// /dev/cu.usbserial node; and a SerialPort that came back already-open
// from a prior tab/page session needs an explicit close() before retry.
async function openWithRetry(port) {
  try { await port.open({ baudRate: 115200 }); }
  catch (err) {
    if (err.name === "InvalidStateError") {
      try { await port.close(); } catch {}
    }
    await new Promise((r) => setTimeout(r, 200));
    await port.open({ baudRate: 115200 });
  }
}

async function connect() {
  if (_port) return;
  if (!("serial" in navigator)) {
    setStatus("error", "unsupported browser");
    log("Web Serial not supported — use Chrome or Edge on desktop");
    return;
  }
  setStatus("connecting", "opening…");
  try {
    _port = await pickOrRequestPort();
  } catch (err) {
    if (err.name !== "NotFoundError") setStatus("error", `pick cancelled: ${err.message}`);
    else setStatus("");
    return;
  }
  try {
    await openWithRetry(_port);
    // Deassert DTR/RTS — ESP32-CAM (and most ESP32 dev boards) wire those
    // through transistors to EN + GPIO0. Chrome's default asserted state
    // on open() pulses them, which resets the chip and kills any active
    // BLE session.
    try { await _port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
  } catch (err) {
    setStatus("error", `open failed: ${err.message}`);
    _port = null;
    return;
  }
  rememberPort(_port);

  ({ term: _term, fit: _fit, resizeObs: _resizeObs } = await mountTerminal($("esp-serial-console-host")));
  _term.focus();

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

  $("esp-serial-connect").textContent = "Disconnect";
  setStatus("connected");
}

async function disconnect() {
  // Release order matters — same dance recovery.js does. Reader.cancel()
  // resolves before the in-flight read() promise settles, so releaseLock()
  // must wait for the read pump to actually exit, otherwise port.close()
  // rejects with "stream is locked" and the port stays in an "open" limbo
  // that blocks a subsequent flash attempt with InvalidStateError.
  try { await _reader?.cancel(); } catch {}
  try { await _readPump; } catch {}
  try { _reader?.releaseLock(); } catch {}
  try { _writer?.releaseLock(); } catch {}
  if (_port) {
    try { await _port.close(); }
    catch {
      await new Promise((r) => setTimeout(r, 500));
      try { await _port.close(); } catch {}
    }
  }
  await new Promise((r) => setTimeout(r, 100));
  _reader = _writer = _readPump = _port = null;
  _resizeObs?.disconnect();
  _resizeObs = null;
  _fit?.dispose();
  _fit = null;
  _term?.dispose();
  _term = null;
  $("esp-serial-console-host").innerHTML = "";
  $("esp-serial-connect").textContent = "Connect";
  setStatus("");
}

async function flashFlow() {
  if (!("serial" in navigator)) {
    setStatus("error", "unsupported browser");
    log("Web Serial not supported — use Chrome or Edge on desktop");
    return;
  }
  if (!confirm("Flash the latest firmware to the connected ESP32?\n\n"
             + "This erases the chip's app + bootloader + partition table "
             + "and replaces them with the build CI most recently published "
             + "to public/firmware/bins/.")) return;
  const reconnectAfter = !!_port;
  if (_port) await disconnect();

  let port;
  try {
    port = await pickOrRequestPort();
    await openWithRetry(port);
  } catch (err) {
    if (err.name !== "NotFoundError") log(`ESP flash port: ${err.message}`);
    setStatus("");
    return;
  }
  setStatus("connected", "flashing…");
  $("esp-serial-flash").disabled = true;

  // Throwaway terminal for esptool-js progress output. No FitAddon — the
  // term is short-lived and disposed in the finally block; if we reconnect
  // after flash, connect() builds the live xterm fresh.
  const { term } = await mountTerminal($("esp-serial-console-host"), { fit: false, convertEol: true });

  try {
    const { flashFirmware } = await import("./flasher.js");
    await flashFirmware(port, term, (fileIndex, pct) => {
      setStatus("connected", `flashing file ${fileIndex} ${pct}%`);
    });
    setStatus("connected", "flash done");
  } catch (err) {
    log(`Flash failed: ${err.message}`);
    term.writeln(`\r\n[flash error: ${err.message}]`);
    setStatus("error", err.message);
  } finally {
    try { await port.close(); } catch {}
    term.dispose();
    $("esp-serial-flash").disabled = false;
  }

  // esptool-js's hardReset auto-resets the chip after flash, so re-opening
  // the live console catches the boot sequence in a freshly-cleared term.
  if (reconnectAfter) await connect();
}

// Same purpose as recovery.releasePort — see comment there.
export async function releasePort() { if (_port) await disconnect(); }

export function init() {
  if (_wired) return;
  _wired = true;
  $("console-close").addEventListener("click", () => $("console-modal").close());
  $("esp-serial-connect").addEventListener("click", () => _port ? disconnect() : connect());
  $("esp-serial-flash").addEventListener("click", flashFlow);
  // Auto-disconnect when the dialog closes — leaving the port open across
  // dialog hides would block other tools (Flash button) from reusing it.
  $("console-modal").addEventListener("close", () => { if (_port) disconnect(); });
}
