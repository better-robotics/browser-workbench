// Desktop-side phone-screen-mode resolver. Subscribes to phone.
// attached / phone.detached events on the shared bus and translates
// them into setPhoneScreenMode calls, reading the user's preference
// (settings.phoneAttachedMode) to pick between sibling rendering
// modes.
//
// Before this plugin existed, the resolution was duplicated in two
// places (phones.js reconnect path and phone-helpers.js attachPhone-
// CameraTo) with no single owner of "what does mounted mean visually."
// Both call sites now just emit phone.attached and forget; this file
// is the only place the settings key is read.
//
// Off-switch: don't call initPhoneScreenModePlugin() in app.js. Phones
// stay in "default" mode on mount (the operator chrome doesn't hide).
// One-line cut.

import { on } from "./event-bus.js";
import { setPhoneScreenMode } from "./phones.js";
import { settings } from "./settings.js";

export function initPhoneScreenModePlugin() {
  on("phone.attached", ({ phoneId, robotLabel }) => {
    const mode = settings.phoneAttachedMode === "operator-cam"
      ? "operator-cam"
      : "pip-face";
    setPhoneScreenMode(phoneId, mode, robotLabel);
  });
  on("phone.detached", ({ phoneId }) => {
    setPhoneScreenMode(phoneId, "default");
  });
}
