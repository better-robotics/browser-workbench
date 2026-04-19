import { $ } from "./dom.js";
import { ask } from "./claude.js";

// Auto-dismiss timings match Buddy: 10s total show, fade begins at 7s (last 3s).
const SHOW_MS = 10000;
const FADE_MS = 7000;
// Don't spam Pip if the user opens/closes dialogs rapidly.
const MIN_GAP_MS = 15000;

const PIP_SYSTEM = [
  "You are Pip, a small assistant in a robotics dashboard for ESP32 and",
  "Raspberry Pi robots. One short sentence, under 140 characters.",
  "Warm, specific, concrete. No emoji, no sign-off, no preamble. Speak like",
  "a colleague who knows this codebase — never generic platitudes.",
].join(" ");

// Dialog id → { context for Claude, fallback line when Claude isn't reachable }
const CONTEXTS = {
  "setup-dialog": {
    name: "Add a robot",
    hint: "Two paths: flash an ESP32 via USB, or set up a Raspberry Pi.",
    fallback: "Pick the type that matches your hardware — ESP32 over USB or a Pi.",
  },
  "prepare-dialog": {
    name: "Set up a Pi robot",
    hint: "Stages firmware, dashboard key, and the runtime onto the SD card's boot partition.",
    fallback: "Make sure the SD card is mounted — this writes firmware to the boot partition.",
  },
  "pinout-modal": {
    name: "Pinout",
    hint: "Pi 40-pin header color-coded by function (5V, 3V3, GPIO, I2C).",
    fallback: "5V is on pins 2 and 4 — easy to short against a neighboring GPIO.",
  },
  "recovery-modal": {
    name: "Recovery terminal",
    hint: "USB serial console to the Pi; works when BLE is dead.",
    fallback: "Physical cable is the auth boundary — USB gives you root without any key.",
  },
};

let _bubble, _panel, _message;
let _fadeTimer = null, _closeTimer = null;
let _lastNotifyAt = 0;

const setSpeaking = (on) => _bubble.classList.toggle("speaking", on);

function cancelAutoDismiss() {
  if (_fadeTimer)  { clearTimeout(_fadeTimer);  _fadeTimer = null; }
  if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
  _panel.classList.remove("fading");
}

function close() {
  cancelAutoDismiss();
  _panel.close();
  setSpeaking(false);
}

function open({ autoDismiss = false } = {}) {
  cancelAutoDismiss();
  if (!_panel.open) _panel.show();
  setSpeaking(true);
  if (autoDismiss) {
    _fadeTimer  = setTimeout(() => _panel.classList.add("fading"), FADE_MS);
    _closeTimer = setTimeout(close, SHOW_MS);
  }
}

// Public API — any module can push a line from Pip. Auto-dismissing is the
// default for spontaneous speech; pass { autoDismiss: false } for sticky ones.
export function speakMessage(text, { autoDismiss = true } = {}) {
  _message.textContent = text;
  open({ autoDismiss });
}

async function notify(dialogId) {
  const ctx = CONTEXTS[dialogId];
  if (!ctx) return;
  const now = Date.now();
  if (_panel.open) return;                      // don't interrupt
  if (now - _lastNotifyAt < MIN_GAP_MS) return; // don't spam
  _lastNotifyAt = now;
  const prompt = `The user just opened the ${ctx.name} panel. Context: ${ctx.hint}\n\nGive Pip's one-line nudge.`;
  const text = (await ask(prompt, { system: PIP_SYSTEM })) ?? ctx.fallback;
  speakMessage(text);
}

// Fire notify() when a dialog's `open` attribute is added. Cheap, and lets other
// modules open dialogs however they want without knowing Pip exists.
function watchDialogs() {
  for (const id of Object.keys(CONTEXTS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    let wasOpen = el.hasAttribute("open");
    new MutationObserver(() => {
      const isOpen = el.hasAttribute("open");
      if (isOpen && !wasOpen) notify(id);
      wasOpen = isOpen;
    }).observe(el, { attributes: true, attributeFilter: ["open"] });
  }
}

export function initAssistant() {
  _bubble  = $("assistant-bubble");
  _panel   = $("assistant-panel");
  _message = $("assistant-message");
  // User-initiated open stays until user closes — auto-dismiss only for bot-initiated.
  _bubble.addEventListener("click", () => { _panel.open ? close() : open(); });
  $("assistant-close").addEventListener("click", close);
  watchDialogs();
}
