// Browser-native TTS. One module so the watcher's speak action, user
// scripts, and Pip's speak tool all share the same voice — flipping
// to a different voice (or to a cloud TTS) is a single-file change.
//
// Web Speech has no gender field. Voice is picked by an ordered name
// allowlist that prefers the natural-sounding male voices on each
// platform (macOS Alex, Windows 11 Microsoft Guy, etc.), then falls
// back to anything tagged "male", then to whatever's available.
//
// cancel() before each utterance because queued speech feels broken
// during a fast reflex loop — the user hears the third detection
// announce only after the first two finish. Latest thought wins.

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

export function speak(text) {
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

// Diagnostic — exposed on window so the user can audit voice selection
// from DevTools without having to introspect the module.
export function currentVoice() {
  return _voice ? { name: _voice.name, lang: _voice.lang } : null;
}
if (typeof window !== "undefined") window.currentVoice = currentVoice;
