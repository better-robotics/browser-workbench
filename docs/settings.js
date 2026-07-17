const SETTINGS_KEY = "better-robotics:settings";

// Stored values are a wire format: a setting renamed in code has to keep
// meaning what it already means on disk. Without this an existing browser
// loads an unknown backend, fails the credential check, and gets asked for
// an API key it never needed.
function migrateSettings(stored) {
  if (stored.pipBackend === "bridge") stored.pipBackend = "subscription";
  return stored;
}

// Value domains live next to the code that reads them: backends and Claude
// variants in pip/claude.js, detectors in perception/detectors.js. Keys stay
// in localStorage — same-origin, never sent anywhere, but treat like passwords.
//
// pipVisionEnabled defaults ON deliberately. Filtering view_robot_frame out of
// getTools() doesn't stop the model saying "let me check the camera" — the
// prior is strong enough that hiding the tool suppresses the capability but
// not the commitment, which just makes Pip lie. /vision off if cost or privacy
// starts to bite.
export const settings = Object.assign(
  { pipBackend: "subscription", pipApiKey: "", pipOpenaiKey: "", pipClaudeModel: "claude-sonnet-5", pipVisionEnabled: true, pipDetector: "mediapipe" },
  migrateSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")),
);

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
