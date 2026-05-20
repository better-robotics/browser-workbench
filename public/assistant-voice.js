import { escapeHtml } from "./dom.js";
import { isSupported as voiceInputSupported, startDictation } from "./voice-input.js";
import { tryMatchCommand, SAFETY_INTENTS } from "./voice-commands.js";
import { onSpeakingChange, isSpeaking } from "./voice.js";

// Web Speech dictation on pip's input. Injected post-init because pip-core
// doesn't expose an input-area hook; we sit alongside its pip-slash-key on
// the left edge using the same form-as-container pattern. Mic missing in
// the browser (Firefox, older Safari builds) → the button just isn't
// inserted, no broken affordance.
let _dictation = null;
// Sticky-mic flag: when true (user clicked the mic to enable), dictation
// auto-restarts after every commit (submit / mid-turn injection / safety
// verb). When false (user explicitly stopped, hit Escape, or never
// started), dictation stays off after the next end-event. The motivation
// is the "talk to your robot" loop — clicking the mic once should be
// enough to issue a sequence of commands without re-clicking between each.
let _micSticky = false;
// Consecutive no-speech failures. Web Speech can flake (TTS-feedback gate
// cuts a session mid-utterance, mic permission lapses, Bluetooth route
// change) and the sticky restart loop would otherwise re-engage a dead
// recognizer forever. After 2 consecutive failures we disarm sticky and
// require an explicit re-click. Reset to 0 on any successful transcript.
let _consecutiveNoSpeech = 0;
const NO_SPEECH_GIVE_UP = 2;

// Injected by wireMicButton — turn lifecycle owns activeTurnEl/abort/
// observations; injectVoiceMidTurn is assistant.js's helper that renders
// + dispatches a voice utterance into the in-flight turn; getPip yields
// the pip-core instance for the .scroll element used by surfaceMicNotice.
let _turn = null;
let _getPip = () => null;
let _injectVoiceMidTurn = async () => false;

// Append a short, dismissable mic-status notice into the chat panel —
// same shape as the watcher reflex notices, different color (cyan for
// "informational input feedback"). Falls back to console.log if pip
// hasn't initialized. Bounded to ONE active notice at a time per panel;
// re-calling replaces the previous so the chat doesn't accumulate them
// if Web Speech is flaking.
function surfaceMicNotice(text) {
  const pip = _getPip();
  if (!pip?.scroll) { console.log("[voice-input]", text); return; }
  const scroll = pip.scroll;
  // Drop any prior notice — keeps the panel from filling up with stale
  // "Didn't catch that" lines during a flaky-mic spell.
  scroll.querySelectorAll(".pip-mic-notice").forEach(n => n.remove());
  const el = document.createElement("div");
  el.className = "pip-mic-notice";
  el.innerHTML =
    `<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">` +
      `<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" stroke="currentColor" stroke-width="1.6" fill="none"/>` +
    `</svg> ` +
    escapeHtml(text);
  scroll.appendChild(el);
  scroll.scrollTop = scroll.scrollHeight;
}

export function wireMicButton(deps) {
  _turn = deps.turn;
  _getPip = deps.getPip;
  _injectVoiceMidTurn = deps.injectVoiceMidTurn;
  if (!voiceInputSupported()) return;
  const form = document.querySelector(".pip-form");
  const input = form?.querySelector(".pip-input");
  if (!form || !input) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pip-mic-btn";
  btn.setAttribute("aria-label", "Voice input");
  btn.title = "Voice input — click on; stays on across commands (click again or Escape to stop)";
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM19 11a7 7 0 0 1-14 0M12 18v3M8 21h8"
          stroke="currentColor" stroke-width="1.6" fill="none"
          stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  // Append so the button lives at the right edge of the form alongside
  // pip-core's send button. CSS pins it absolutely at right:32, so DOM
  // order is incidental — appendChild keeps the form-control tab order
  // intuitive (input → mic → send).
  form.appendChild(btn);
  form.classList.add("pip-form--mic");

  const setListening = (on) => {
    btn.classList.toggle("listening", on);
    btn.setAttribute("aria-pressed", String(!!on));
  };

  // Snapshot whatever's in the input when dictation starts so the
  // transcript appends to existing text rather than nuking it. Cancel
  // restores this prefix so the user gets their pre-dictation state back.
  let prefix = "";
  const writeTranscript = (text) => {
    input.value = (prefix ? prefix + " " : "") + text;
    // Dispatch input event so pip-core's send-button visibility logic runs.
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const stop = ({ cancel = false } = {}) => {
    if (!_dictation) return;
    _dictation.stop({ cancel });
    _dictation = null;
    setListening(false);
  };

  const start = () => {
    if (_dictation) { stop(); return; }
    // Don't open the mic while TTS is currently speaking — the recognizer
    // would transcribe the robot's own voice as the next user command
    // (classic full-duplex problem; Alexa/Siri/Google all suspend mic
    // during their own TTS playback for this reason). The speaking-end
    // listener below will call start() again once audio finishes if
    // sticky is on.
    if (isSpeaking()) return;
    prefix = input.value.trim();
    setListening(true);
    // CSS hook for "sticky-mode armed" — a subtle persistent ring around
    // the mic so the operator knows clicking won't be needed between
    // commands.
    btn.classList.toggle("sticky", _micSticky);
    _dictation = startDictation({
      onInterim: writeTranscript,
      onFinal: (final) => { if (final) writeTranscript(final); },
      // Instant-fire for safety verbs. When Web Speech promotes a chunk
      // to final (typically at a natural pause), try the matcher. If
      // it's a safety intent (stop/halt), execute immediately without
      // waiting for the silence-commit window. Mid-turn injection
      // handles rendering + observation queueing.
      onFinalChunk: async (chunkedFinal) => {
        const m = tryMatchCommand(chunkedFinal);
        if (!m || !SAFETY_INTENTS.has(m.intent)) return;
        // Stop dictation immediately and clear the input — otherwise the
        // onEnd handler about to fire would re-dispatch the same command.
        // The empty-text short-circuit in onEnd (`if (!text) return`) is
        // what guards against the double-fire.
        stop();
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        if (_turn.isActive()) {
          await _injectVoiceMidTurn(chunkedFinal);
        } else {
          // No active turn — open one ourselves via synth-submit so the
          // safety action still renders as a turn the user can audit.
          // We restore the transcript so the onSubmit matcher path can
          // dispatch it cleanly.
          input.value = chunkedFinal;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          requestAnimationFrame(() => form.requestSubmit?.());
        }
      },
      onError: (err) => {
        console.warn("[voice-input]", err);
        if (err === "not-allowed") {
          input.placeholder = "Microphone permission denied — check Site settings.";
          _micSticky = false;
          surfaceMicNotice("Microphone permission denied — click the mic icon in the address bar to allow.");
          return;
        }
        if (err === "no-speech") {
          _consecutiveNoSpeech++;
          if (_consecutiveNoSpeech >= NO_SPEECH_GIVE_UP) {
            // Two in a row — recognizer is probably stuck (TTS cut a
            // session mid-utterance, mic route changed). Disarm sticky
            // so we stop the dead-loop and surface an actionable hint.
            _micSticky = false;
            surfaceMicNotice("Didn't hear anything twice in a row — click the mic again to retry.");
          } else {
            surfaceMicNotice("Didn't catch that — try again.");
          }
        }
      },
      onEnd: async ({ reason }) => {
        // Chrome can fire onend on idle even with continuous=true — flip
        // the button back so the user can re-engage with one click instead
        // of two.
        _dictation = null;
        setListening(false);
        // Helper: re-arm dictation after a commit when the user's sticky
        // intent is still on. Small delay so (a) the form submit
        // dispatches before we re-grab the input element and (b) the
        // mic's audio buffer flushes the just-spoken utterance before
        // listening again (otherwise the next session can sometimes
        // pick up the tail of the prior one as a phantom command).
        const restartIfSticky = () => {
          if (!_micSticky) return;
          setTimeout(() => { if (_micSticky && !_dictation) start(); }, 400);
        };
        if (reason === "cancel") {
          // Escape: restore pre-dictation input so the user gets their
          // earlier draft back instead of the partial transcript. Escape
          // also clears sticky — explicit "stop listening" intent.
          _micSticky = false;
          input.value = prefix;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
          return;
        }
        const text = input.value.trim();
        if (!text) { input.focus(); restartIfSticky(); return; }
        // We got real text — recognizer is healthy. Reset the streak so
        // a future flaky-mic spell starts counting fresh.
        _consecutiveNoSpeech = 0;

        // Mid-turn voice: don't go through pip-core's submit (input is
        // disabled during a running turn anyway). Inject as observation
        // — if it's a command, also execute it directly; either way the
        // planner sees it on its next iteration.
        if (_turn.isActive()) {
          await _injectVoiceMidTurn(text);
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
          restartIfSticky();
          return;
        }

        // Idle path: normal submit through pip. Let the input event
        // flush + render before submit, so the user sees the final
        // transcript flash in the field for a beat.
        requestAnimationFrame(() => form.requestSubmit?.());
        restartIfSticky();
      },
    });
  };

  // Click toggles sticky-mode + dictation. First click → arm sticky AND
  // start listening; second click → disarm sticky AND stop. Auto-restart
  // in onEnd checks sticky; so submits / mid-turn injections don't drop
  // the mic between commands.
  btn.addEventListener("click", () => {
    if (_dictation) {
      _micSticky = false;
      stop();
    } else {
      _micSticky = true;
      start();
    }
  });
  // Escape from anywhere bails an in-progress dictation without sending
  // AND clears sticky — explicit "stop listening" intent.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _dictation) {
      _micSticky = false;
      stop({ cancel: true });
    }
  });

  // TTS feedback-gating. While the robot is speaking, kill the mic so
  // the recognizer can't transcribe its own voice back as the next
  // command. When TTS ends, restart if sticky is on. 300ms tail delay
  // before restart so audio-system AEC has a chance to settle (without
  // this, the very tail of the just-played utterance can be picked up
  // as a phantom one-syllable command).
  //
  // Visual: while muted-by-TTS, swap the listening pulse for a static
  // muted class — operator can SEE the mic is intentionally suspended
  // instead of guessing whether it's dead.
  onSpeakingChange((speaking) => {
    if (speaking) {
      btn.classList.add("muted-tts");
      btn.title = "Muted while robot speaks — will resume after";
      if (_dictation) stop({ cancel: true });  // drop the partial; don't commit phantom audio
    } else {
      btn.classList.remove("muted-tts");
      btn.title = "Voice input — click on; stays on across commands (click again or Escape to stop)";
      if (_micSticky && !_dictation) {
        setTimeout(() => { if (_micSticky && !_dictation && !isSpeaking()) start(); }, 300);
      }
    }
  });
}

export function toggleDictation() {
  // Slash-command entrypoint — same start/stop semantics as the button.
  document.querySelector(".pip-mic-btn")?.click();
}
