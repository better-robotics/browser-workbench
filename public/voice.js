// Browser-native TTS + opt-in OpenAI TTS upgrade. One module so the
// watcher's speak action, user scripts, and Pip's speak tool all share
// the same voice — flipping engines is a single-file change.
//
// Branch: if settings.pipOpenaiKey is configured we POST to OpenAI's
// /v1/audio/speech (much more natural quality, ~$0.0009 per typical
// demo line at tts-1 pricing). Otherwise — and on any OpenAI failure
// (network / key / quota) — fall back to Web Speech so the demo never
// goes silent. Net: zero-config users keep the current voice, users
// who set an OpenAI key get the upgrade automatically.
//
// Web Speech has no gender field. Voice is picked by an ordered name
// allowlist that prefers the natural-sounding male voices on each
// platform (macOS Alex, Windows 11 Microsoft Guy, etc.), then falls
// back to anything tagged "male", then to whatever's available.
//
// cancel() before each utterance because queued speech feels broken
// during a fast reflex loop — the user hears the third detection
// announce only after the first two finish. Latest thought wins.

import { settings } from "./settings.js";

// ─ OpenAI TTS path ──────────────────────────────────────────────────

// onyx is the closest tts-1 voice to a friendly-male-narrator vibe.
// Other options: alloy, echo, fable, nova, shimmer. tts-1 is the fast/
// cheap model; tts-1-hd is ~2× the quality but ~2× the latency + cost.
const OPENAI_TTS_MODEL = "tts-1";
const OPENAI_TTS_VOICE = "onyx";

// Cancel-on-new state: we pause the in-flight Audio element AND abort
// the in-flight fetch so a new speak() pre-empts cleanly instead of
// queueing audio behind a stale request.
let _currentAudio = null;
let _currentAbort = null;

function cancelOpenAIPlayback() {
  if (_currentAbort) { try { _currentAbort.abort(); } catch {} _currentAbort = null; }
  if (_currentAudio) {
    try { _currentAudio.pause(); } catch {}
    if (_currentAudio.src) { try { URL.revokeObjectURL(_currentAudio.src); } catch {} }
    _currentAudio = null;
  }
}

async function speakOpenAI(text, key) {
  cancelOpenAIPlayback();
  // Also cancel any Web Speech still going from a previous turn.
  if (typeof speechSynthesis !== "undefined") {
    try { speechSynthesis.cancel(); } catch {}
  }

  const controller = new AbortController();
  _currentAbort = controller;

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input: text,
      response_format: "mp3",
    }),
    signal: controller.signal,
  });
  if (controller.signal.aborted) return;
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI TTS ${res.status}: ${errText.slice(0, 200)}`);
  }

  const blob = await res.blob();
  if (controller.signal.aborted) return;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  _currentAudio = audio;
  const cleanup = () => {
    if (_currentAudio === audio) _currentAudio = null;
    try { URL.revokeObjectURL(url); } catch {}
  };
  audio.onended = cleanup;
  audio.onerror = cleanup;
  await audio.play();
}

// ─ Web Speech path (the fallback) ───────────────────────────────────

const MALE_NAME_PREFS = [
  "Alex",                    // macOS, premium quality
  "Microsoft Guy Online",    // Windows 11 neural
  "Microsoft Guy",
  "Microsoft David Desktop",
  "Microsoft David",
  "Microsoft Mark",
  "Google UK English Male",
  "Google US English Male",
  "Daniel",                  // macOS UK male
  "Tom", "Aaron", "Fred", "Reed", "Eddy", "James",
];

let _voice = null;
let _voiceResolved = false;

function pickVoice(voices) {
  if (!voices?.length) return null;
  const en = voices.filter(v => v.lang?.toLowerCase().startsWith("en"));
  for (const name of MALE_NAME_PREFS) {
    const hit = en.find(v => v.name === name) || voices.find(v => v.name === name);
    if (hit) return hit;
  }
  // Generic name tag — e.g. "English (United Kingdom)+m" (espeak), "...Male" suffixes.
  const maleTagged = (vs) => vs.find(v => /\bmale\b/i.test(v.name) && !/female/i.test(v.name));
  return maleTagged(en) || maleTagged(voices) || en[0] || voices[0] || null;
}

function refreshVoice() {
  if (typeof speechSynthesis === "undefined") return;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;   // Chrome lazy-loads; voiceschanged fires later
  _voice = pickVoice(voices);
  _voiceResolved = true;
}

if (typeof speechSynthesis !== "undefined") {
  refreshVoice();
  // voiceschanged fires once on Chrome after the remote-voice list arrives,
  // and any time the OS voice catalog changes. addEventListener is the
  // standardized hook; older Safari only exposed onvoiceschanged.
  if ("addEventListener" in speechSynthesis) {
    speechSynthesis.addEventListener("voiceschanged", refreshVoice);
  } else {
    speechSynthesis.onvoiceschanged = refreshVoice;
  }
}

function speakWebSpeech(text) {
  if (!text || typeof speechSynthesis === "undefined") return;
  // If our very first call beat the voiceschanged event, try once more.
  if (!_voiceResolved) refreshVoice();
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    if (_voice) u.voice = _voice;
    speechSynthesis.speak(u);
  } catch {}
}

// ─ Public surface ───────────────────────────────────────────────────

export function speak(text) {
  if (!text) return;
  const key = settings?.pipOpenaiKey;
  if (key) {
    // Fire-and-forget; on any failure, silently fall back to Web Speech
    // so the demo never goes silent because of a network blip / bad key.
    speakOpenAI(String(text), key).catch(err => {
      console.warn("[voice] OpenAI TTS failed, falling back to Web Speech:", err?.message || err);
      speakWebSpeech(text);
    });
    return;
  }
  speakWebSpeech(text);
}

// Diagnostic — exposed on window so the user can audit voice selection
// from DevTools without having to introspect the module.
export function currentVoice() {
  const usingOpenAI = !!settings?.pipOpenaiKey;
  if (usingOpenAI) return { engine: "openai", model: OPENAI_TTS_MODEL, voice: OPENAI_TTS_VOICE };
  return _voice
    ? { engine: "web-speech", name: _voice.name, lang: _voice.lang }
    : { engine: "web-speech", name: null };
}
if (typeof window !== "undefined") window.currentVoice = currentVoice;
