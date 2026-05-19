// Browser-native speech-to-text via the Web Speech API
// (SpeechRecognition / webkitSpeechRecognition). Counterpart to voice.js's
// TTS — both are browser-native, no install, no API key. Caveat: Chrome's
// implementation forwards audio to Google's cloud STT under the hood, so
// this is the one path in the dashboard where audio leaves the tab.
// For the strict no-data-leaving variant, swap to transformers.js + Whisper
// (~100MB model, ~500ms–2s latency) — same shape, different backend.
//
// Push-to-talk by design: caller controls start + stop. continuous=true so
// natural pauses inside a sentence don't drop the session; interimResults=
// true so the UI can show the live transcript as the user speaks.
//
// Custom silence-commit: Chrome's built-in idle timeout (~10s) is far too
// long for short commands ("drive forward" should fire within 1s of
// finishing). We watch onresult activity and call stop() after `silenceMs`
// of no new transcript, which triggers onend → caller's onFinal → submit.
// Caller passes silenceMs=0 to disable (pure manual stop).

const SR = typeof window !== "undefined"
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

export function isSupported() { return !!SR; }

// onFinalChunk fires every time Web Speech promotes a chunk from interim
// to final (typically at a natural pause / breath). Lets the caller try
// pattern-matching against high-confidence text WITHOUT waiting for the
// silence-commit timer — used for "instant-fire" safety verbs like
// "stop" that need sub-second response while the user keeps talking.
export function startDictation({ onInterim, onFinal, onFinalChunk, onError, onEnd, lang = "en-US", silenceMs = 1200 } = {}) {
  if (!SR) {
    onError?.("not-supported");
    onEnd?.();
    return { stop: () => {} };
  }
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = lang;

  let finalText = "";
  let stopped = false;
  let cancelled = false;
  let silenceTimer = null;

  // Each onresult resets this. When it fires (no transcript activity for
  // silenceMs), we stop the recognition. onend then runs with reason
  // "user" — same path as the caller manually stopping — and our existing
  // auto-submit in onEnd fires the transcript.
  const armSilenceTimer = () => {
    if (!silenceMs || stopped || cancelled) return;
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (stopped || cancelled) return;
      stopped = true;
      try { rec.stop(); } catch {}
    }, silenceMs);
  };

  rec.onresult = (e) => {
    let interim = "";
    let promoted = false;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) { finalText += r[0].transcript; promoted = true; }
      else interim += r[0].transcript;
    }
    // Caller sees the running concatenation (finalized so far + current
    // interim) — same model used by Gboard/iOS dictation, lets the input
    // field grow smoothly instead of flickering.
    onInterim?.(finalText + interim);
    if (promoted) onFinalChunk?.(finalText.trim());
    armSilenceTimer();
  };

  rec.onerror = (e) => {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    onError?.(e.error || "unknown");
  };

  rec.onend = () => {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    // We surface three reasons so the caller can distinguish them:
    //   "auto"   — Chrome's own idle timeout (rare now that we silence-stop)
    //   "user"   — caller (or silenceTimer) called stop() — the common commit path
    //   "cancel" — caller called stop({ cancel: true }) to abort (drop it)
    const reason = cancelled ? "cancel" : stopped ? "user" : "auto";
    if (finalText && reason !== "cancel") onFinal?.(finalText.trim(), { reason });
    onEnd?.({ reason });
  };

  try { rec.start(); }
  catch (err) {
    // start() throws if recognition is already running (rare on PTT but
    // possible if the caller double-clicks the mic button before onend).
    onError?.(`start-failed: ${err.message || err}`);
    onEnd?.({ reason: "error" });
    return { stop: () => {} };
  }

  // Don't arm the silence timer at start — that punishes the natural
  // pause between clicking the mic and beginning to speak (the user
  // formulating, finding the right phrase). Chrome's own ~10s idle
  // timeout handles a stray click. The timer only starts running once
  // the first transcript chunk arrives in onresult.

  return {
    stop: ({ cancel = false } = {}) => {
      stopped = true;
      cancelled = !!cancel;
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      try { rec.stop(); } catch {}
    },
  };
}
