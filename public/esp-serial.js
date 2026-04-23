// ESP32 serial monitor — companion to recovery.js (Pi). Different tool because
// ESP32 firmware is line-buffered Serial.println output, not a TTY: ewt-console
// (a log box with optional input) is the right granularity, not xterm. We
// already load esp-web-tools@10 for the Flash button (index.html), so the
// <ewt-console> element is in the bundle for free. See README architecture
// note + the architectural reflection where this got picked.
import { $ } from "./dom.js";

let _wired = false;
let _port = null;

function setStatus(msg) {
  const el = $("esp-serial-status");
  if (el) el.textContent = msg;
}

async function connect() {
  if (_port) return;
  setStatus("requesting port…");
  try {
    _port = await navigator.serial.requestPort();
  } catch (err) {
    if (err.name !== "NotFoundError") setStatus(`pick cancelled: ${err.message}`);
    else setStatus("disconnected");
    return;
  }
  // Don't call port.open() — ewt-console opens it itself with the right baud
  // and signal flags. Just hand it the SerialPort and it takes over.
  const console = $("esp-serial-console");
  console.port = _port;
  $("esp-serial-connect").textContent = "Disconnect";
  setStatus("connected");
}

async function disconnect() {
  const console = $("esp-serial-console");
  // ewt-console closes the underlying port when port is cleared / element
  // is removed. Setting to null is the cleanest detach.
  if (console) console.port = null;
  if (_port) { try { await _port.close(); } catch {} _port = null; }
  $("esp-serial-connect").textContent = "Connect";
  setStatus("disconnected");
}

export function init() {
  if (_wired) return;
  _wired = true;
  $("esp-serial-close").addEventListener("click", () => $("esp-serial-modal").close());
  $("esp-serial-connect").addEventListener("click", () => _port ? disconnect() : connect());
  // Auto-disconnect when the dialog closes — leaving the port open across
  // dialog hides would block other tools (Flash button) from reusing it.
  $("esp-serial-modal").addEventListener("close", () => { if (_port) disconnect(); });
}

export function openESPSerialDialog() {
  $("esp-serial-modal").showModal();
}
