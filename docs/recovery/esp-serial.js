// ESP32 firmware flashing (esptool-js). Console monitoring for both Pi and
// ESP32 lives in console.js now — this module owns only the install/flash
// flow, which both the setup card and the console's Flash firmware button
// route through via installEsp32().
import { $ } from "../dom.js";
import { log } from "../log.js";
import { BOARDS, boardsForChip, ESP_USB_VIDS } from "./boards.js";

let _wired = false;

const ESP_FILTERS = ESP_USB_VIDS.map((usbVendorId) => ({ usbVendorId }));

// Hand a closed port to esptool-js; let it run its own reset sequence.
// An earlier version did an open()→close() probe here, but each open()
// pulses DTR/RTS and resets the chip — by the time esptool tried to
// enter download mode the chip had already booted into normal firmware
// (which doesn't speak the esptool protocol) and sync timed out with
// "No serial data received". The right defense for a wedged port is
// the catch block in installEsp32 below, which triggers forget +
// re-prompt only when esptool actually fails to open.
async function preparePortForInstall(port) {
  // Defensive close — handles same-tab wedge from a prior session.
  // close() on an already-closed port throws; the catch swallows.
  try { await port.close(); } catch {}
  return port;
}

function isPortLockedError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  // "already open" catches SerialPort.open() on a still-open port; "locked
  // to a reader" catches the Streams-API TypeError when a prior attempt's
  // reader/writer was never released (e.g. resetChip() skipped after an
  // earlier throw) — same wedged-port condition, different error shape.
  return err.name === "InvalidStateError" || msg.includes("already open") || msg.includes("locked to a reader");
}

// BOARDS catalog is imported from boards.js — single source of truth
// shared with pinout.js. The picker UI here consumes id, chip, label,
// sub, usbHints; pinout.js consumes pinsTop/pinsBot/pcbLabel/
// footerNote/cameraReservedGpios from the same entries.

const LAST_BOARD_KEY = "esp-flash:last-board";

// Install-dialog state machine. One <dialog> hosts the full arc —
// connecting → picking → flashing → done — so the operator sees one
// surface from click to chip-reset instead of a sequence of modals.
function setFlashStatus(text) { $("esp-flash-status").textContent = text; }
function setFlashSubtitle(text) { $("esp-flash-subtitle").textContent = text || ""; }

// In-memory esptool trace buffer. Written to as plain array pushes (no
// DOM) so it doesn't stall sync timing the way per-byte DOM writes did.
// Flushed to the <pre> on disclosure open.
let _flashTrace = [];
function pushFlashTrace(line) {
  _flashTrace.push(line);
  // Live tail: if the disclosure is open while the install runs, append
  // each line and pin scroll to the bottom. Closed → buffer-only, full
  // render on next open.
  const details = $("esp-flash-details");
  if (details?.open) {
    const pre = $("esp-flash-trace");
    if (pre.textContent) pre.appendChild(document.createTextNode("\n"));
    pre.appendChild(document.createTextNode(line));
    pre.scrollTop = pre.scrollHeight;
  }
}
function renderFlashTrace() {
  const pre = $("esp-flash-trace");
  pre.textContent = _flashTrace.join("\n");
  pre.scrollTop = pre.scrollHeight;
}
function setFlashProgress(pct, sub = "") {
  $("esp-flash-progress-fill").style.width = `${pct}%`;
  $("esp-flash-progress-sub").textContent = sub;
}
function resetFlashDialog() {
  $("esp-flash-pick").hidden = true;
  $("esp-flash-progress").hidden = true;
  setFlashProgress(0, "");
  $("esp-flash-install").hidden = false;
  $("esp-flash-install").disabled = true;
  $("esp-flash-cancel").disabled = false;
  $("esp-flash-cancel").textContent = "Cancel";
  $("esp-flash-empty").hidden = true;
  $("esp-flash-boards").innerHTML = "";
  setFlashSubtitle("");
  $("esp-flash-status").classList.remove("success", "error");
  _flashTrace = [];
  $("esp-flash-details").open = false;
  $("esp-flash-trace").textContent = "";
}
function flashDialogState(state) {
  const install = $("esp-flash-install");
  const cancel  = $("esp-flash-cancel");
  switch (state) {
    case "connecting":
      $("esp-flash-pick").hidden = true;
      $("esp-flash-progress").hidden = true;
      install.disabled = true;
      cancel.disabled = false;
      cancel.textContent = "Cancel";
      break;
    case "picking":
      $("esp-flash-pick").hidden = false;
      $("esp-flash-progress").hidden = true;
      cancel.disabled = false;
      cancel.textContent = "Cancel";
      break;
    case "flashing":
      $("esp-flash-pick").hidden = true;
      $("esp-flash-progress").hidden = false;
      install.disabled = true;
      cancel.disabled = true;
      break;
    case "done":
      $("esp-flash-pick").hidden = true;
      $("esp-flash-progress").hidden = false;
      install.hidden = true;
      cancel.disabled = false;
      cancel.textContent = "Done";
      $("esp-flash-status").classList.add("success");
      $("esp-flash-status").classList.remove("error");
      break;
    case "error":
      install.disabled = true;
      cancel.disabled = false;
      cancel.textContent = "Close";
      $("esp-flash-status").classList.add("error");
      $("esp-flash-status").classList.remove("success");
      break;
  }
}

// Picker promise managed via module-level resolver — the install/cancel
// buttons have permanent listeners (wired once in init()) that drive
// this. Avoids a per-call add/removeEventListener dance and the listener
// leak that comes with it. Null when no pick is in flight.
let _pickerResolve = null;

function pickBoardInDialog({ chip, chipName, portInfo = {} }) {
  return new Promise((resolve) => {
    _pickerResolve = (val) => { _pickerResolve = null; resolve(val); };

    const compatible = boardsForChip(chip);
    setFlashStatus(`Detected: ${chipName || chip}`);
    setFlashSubtitle(chipName || chip);

    const boardsEl = $("esp-flash-boards");
    boardsEl.innerHTML = "";
    if (compatible.length === 0) {
      $("esp-flash-empty").hidden = false;
      $("esp-flash-install").disabled = true;
    } else {
      $("esp-flash-empty").hidden = true;
      // VID hint + last-used. Hint only wins when *exactly one* board
      // matches the port's VID — two boards sharing a bridge (CP210x is
      // common on both AI-Thinker and DevKitV1) makes the hint ambiguous,
      // in which case we fall back to last-used so the user's prior
      // pick stays sticky.
      const vid = portInfo.usbVendorId;
      const hintMatches = vid ? compatible.filter(b => b.usbHints.includes(vid)) : [];
      const byHint = hintMatches.length === 1 ? hintMatches[0] : null;
      const lastId = localStorage.getItem(LAST_BOARD_KEY);
      const byLast = compatible.find(b => b.id === lastId);
      const preselect = (byHint || byLast || compatible[0]).id;

      for (const b of compatible) {
        const label = document.createElement("label");
        label.className = "esp-flash-board-option";
        label.innerHTML = `
          <input type="radio" name="esp-flash-board" value="${b.id}"${b.id === preselect ? " checked" : ""}>
          <span class="esp-flash-board-title">${b.label}</span>
          <span class="esp-flash-board-sub meta">${b.sub}</span>`;
        boardsEl.appendChild(label);
      }
      $("esp-flash-install").disabled = false;
    }
    syncBundleVersion();
    // Subtitle: prefer the preselected board's friendly label over the
    // bare chip name set during detect.
    const initial = boardsEl.querySelector("input[name='esp-flash-board']:checked");
    const initialBoard = initial && BOARDS.find(b => b.id === initial.value);
    if (initialBoard) setFlashSubtitle(initialBoard.label);
    flashDialogState("picking");
    // HIG: one keypress to commit on the happy path. Focus the Install
    // button after the boards render so power users can hit Enter.
    $("esp-flash-install").focus();
  });
}

// Bundle version line. Reflects what's about to be flashed — fetched
// from the picked variant's manifest.json. Used as a sanity check so
// the operator can cross-reference what they're installing against
// what the chip reports after boot (fw_info.version).
function humanRelative(isoStr) {
  const t = Date.parse(isoStr);
  if (Number.isNaN(t)) return "";
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

let _versionFetchToken = 0;  // latest-wins guard for in-flight fetches
async function syncBundleVersion() {
  const versionEl = $("esp-flash-version");
  if (!versionEl) return;
  const picked = $("esp-flash-boards").querySelector("input[name='esp-flash-board']:checked");
  if (!picked) { versionEl.textContent = ""; return; }
  const board = BOARDS.find(b => b.id === picked.value);
  if (!board) { versionEl.textContent = ""; return; }
  const bundleId = board.id;

  const token = ++_versionFetchToken;
  versionEl.textContent = "Loading bundle…";
  try {
    const r = await fetch(`firmware/bins/${bundleId}/manifest.json`, { cache: "no-cache" });
    if (token !== _versionFetchToken) return;  // user changed picks mid-flight
    if (!r.ok) {
      versionEl.textContent = "Bundle not published yet for this board.";
      return;
    }
    const m = await r.json();
    if (token !== _versionFetchToken) return;
    let text = `Bundle: ${m.version || "unknown"}`;
    if (m.built_at) {
      const ago = humanRelative(m.built_at);
      if (ago) text += ` · built ${ago}`;
    }
    versionEl.textContent = text;
  } catch {
    if (token !== _versionFetchToken) return;
    versionEl.textContent = "";
  }
}

// Canonical install entry point. Both flash buttons (front-page setup
// card, serial-console modal) route here. Returns { board, chip } on
// success, null on cancel.
export async function installEsp32() {
  if (!("serial" in navigator)) {
    log("Web Serial not supported — use Chrome or Edge on desktop");
    return null;
  }
  // init() binds the install-dialog button listeners. Idempotent (the
  // _wired flag short-circuits repeat calls), but must be called here
  // because front-page entry can fire before the user ever opens the
  // console dialog. Callers (setup card, console's Flash button) are
  // responsible for releasing any console port they hold first — Web
  // Serial open() throws if the port is already in use elsewhere in
  // this tab, and this module no longer tracks a console port itself.
  init();

  // requestPort() must be called synchronously from the user-gesture
  // handler. The dialog opens *after* the port is in hand so a port-pick
  // cancel doesn't leave an empty dialog on screen. Always the full
  // chooser (no getPorts() shortcut) — with two ESPs plugged in, the
  // operator needs to pick which one to flash, not auto-get whichever
  // was authorized first.
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: ESP_FILTERS });
  } catch (err) {
    if (err.name !== "NotFoundError") log(`ESP port pick: ${err.message}`);
    return null;
  }

  resetFlashDialog();
  flashDialogState("connecting");
  setFlashStatus("Connecting to chip…");
  const modal = $("esp-flash-modal");
  if (!modal.open) modal.showModal();

  await preparePortForInstall(port);

  const runFlash = async (p) => {
    const portInfo = (() => { try { return p.getInfo(); } catch { return {}; } })();
    // Surface the USB bridge ids in the trace — diagnostic for "two boards,
    // both default to AI-Thinker" cases. If both ports share a VID (e.g.,
    // CP210x is common on both boards), the picker's hint is ambiguous and
    // falls back to last-used.
    const vid = portInfo.usbVendorId;
    const pid = portInfo.usbProductId;
    if (vid !== undefined) {
      pushFlashTrace(`port: vid=0x${vid.toString(16).padStart(4, "0")} pid=0x${(pid || 0).toString(16).padStart(4, "0")}`);
    }
    const { flashFirmware } = await import("./flasher.js");
    return await flashFirmware(p, {
      onLog: setFlashStatus,
      onProgress: (fileIndex, pct, totalFiles) => {
        flashDialogState("flashing");
        setFlashProgress(pct, `File ${fileIndex + 1} of ${totalFiles} — ${pct}%`);
      },
      onTrace: pushFlashTrace,
      pickBoard: ({ chip, chipName }) => pickBoardInDialog({ chip, chipName, portInfo }),
    });
  };

  let result = null;
  try {
    result = await runFlash(port);
  } catch (err) {
    if (isPortLockedError(err)) {
      // Cached SerialPort wedged (held by another tab / kernel race /
      // phantom-open). Revoke the grant and re-prompt for a fresh handle,
      // then retry once.
      log(`ESP install: port locked (${err.message}); revoking grant and re-prompting`);
      try { await port.forget(); } catch {}
      try {
        port = await navigator.serial.requestPort({ filters: ESP_FILTERS });
        await preparePortForInstall(port);
        result = await runFlash(port);
      } catch (err2) {
        if (err2.name === "NotFoundError") {
          modal.close();
          return null;
        }
        log(`Install retry failed: ${err2.message}`);
        setFlashStatus(`Install failed: ${err2.message}`);
        flashDialogState("error");
      }
    } else {
      log(`Install failed: ${err.message}`);
      setFlashStatus(`Install failed: ${err.message}. If the chip is an AI-Thinker bare module, hold the BOOT button while clicking Install.`);
      flashDialogState("error");
    }
  } finally {
    // flashFirmware's resetChip already pulsed RTS and released the
    // transport's reader/writer locks. Brief pause for the FTDI driver
    // to settle before close, then close. Failure here is visible in
    // the trace panel — "the port is locked" means the transport
    // disconnect didn't release everything and the install can't
    // re-acquire the port without a tab reload.
    await new Promise((r) => setTimeout(r, 300));
    try { await port.close(); pushFlashTrace("port.close() ok"); }
    catch (err) { pushFlashTrace(`port.close() failed (${err?.message || err})`); }
  }

  if (result) {
    setFlashProgress(100, "Done.");
    flashDialogState("done");
    setFlashStatus(`Installed ${result.board}. If the chip doesn't boot in a few seconds, unplug and replug it — auto-reset isn't reliable on every USB-UART bridge.`);
  } else if (result === null && !$("esp-flash-status").textContent.startsWith("Install failed")) {
    // Cancelled at the picker — close immediately.
    modal.close();
  }
  return result;
}

export function init() {
  if (_wired) return;
  _wired = true;
  // Install-dialog button wiring — bound once, driven by state. Cancel
  // doubles as Close in done/error states (its label changes accordingly).
  $("esp-flash-install").addEventListener("click", () => {
    if (!_pickerResolve) return;
    const picked = $("esp-flash-boards").querySelector("input[name='esp-flash-board']:checked");
    if (!picked) return;
    const board = BOARDS.find(b => b.id === picked.value);
    localStorage.setItem(LAST_BOARD_KEY, board.id);
    _pickerResolve(board.id);
  });
  $("esp-flash-cancel").addEventListener("click", () => {
    if (_pickerResolve) _pickerResolve(null);
    else $("esp-flash-modal").close();
  });
  $("esp-flash-close").addEventListener("click", () => {
    if (_pickerResolve) _pickerResolve(null);
    $("esp-flash-modal").close();
  });
  $("esp-flash-boards").addEventListener("change", () => {
    syncBundleVersion();
    const picked = $("esp-flash-boards").querySelector("input[name='esp-flash-board']:checked");
    const board  = picked && BOARDS.find(b => b.id === picked.value);
    if (board) setFlashSubtitle(board.label);
  });
  // Lazy-render the esptool trace on disclosure open. Buffer is appended
  // to throughout the install with no DOM cost; the textContent assignment
  // here is one shot.
  $("esp-flash-details").addEventListener("toggle", (e) => {
    if (e.target.open) renderFlashTrace();
  });
  // Backstop: Escape closes <dialog> directly — make sure a pending pick
  // resolves so installEsp32's await doesn't hang.
  $("esp-flash-modal").addEventListener("close", () => {
    if (_pickerResolve) _pickerResolve(null);
  });
}
