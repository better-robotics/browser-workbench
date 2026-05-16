# Notes

Operator-private notes — decisions, competitive analysis, feature design rationale.
Encrypted at rest via git-crypt; sections inside.

---

# Competitors

External systems that compete for the same user decision as Better Robotics — *"how do I write code for a small robot from a browser tab without installing anything."* Not an encyclopedia; filtered for what would change a decision.

## schematik.io — not in this lane

[schematik.io](https://schematik.io) bills itself as "Cursor for Hardware": AI code-generation that emits firmware / schematic-adjacent code from natural language for Arduino, ESP32, Raspberry Pi (~$4.6M pre-seed). Not a pairing UI, not a control plane, not a dashboard. The name similarity is the whole story. A *potential input* for authoring firmware like ours, not a competitor to the runtime-control story. No overlap with the seven architectural bets below.

## The real candidates

### LEGO SPIKE web app (spike.legoeducation.com)
- **Competes for:** the classroom decision — "which kit lets students code from a Chromebook with no install."
- **Overlap:** Web Bluetooth + WebSerial in Chrome, no native app ([Chrome for Developers](https://developer.chrome.com/blog/lego-education-spike-web-bluetooth-web-serial)). Programs upload to hub, hub executes.
- **Divergence:** code runs *on the hub*, not the browser. Closed hardware, closed firmware, no user-owned OTA.
- **Better than us today:** mature curriculum, institutional purchase channel.
- **Decision impact:** confirms BLE-first-via-browser as mainstream, not contrarian. Does not threaten browser-as-brain — they deploy to hub; we deliberately don't.

### Sphero EDU web app
- **Competes for:** same classroom decision as LEGO.
- **Overlap:** Web Bluetooth pairing of BOLT+/BOLT/Mini/RVR ([help.sphero.com](https://help.sphero.com/sphero-support/connecting-robots-in-the-sphero-edu-web-app)).
- **Divergence:** Sphero account required, their robots only. No user-owned firmware, no recovery plane, no LLM surface.
- **Better than us today:** polished UI, k-12 marketplace presence, iOS native fallback.
- **Decision impact:** reinforces the "no account" moat — account-gating is exactly the friction this project refuses.

### Makeblock (mBlock + mBot family)
- **Competes for:** same K-12 classroom decision — at the largest scale claim of any vendor in this list (200k+ schools).
- **Overlap:** mBlock 5 web at [ide.mblock.cc](https://ide.mblock.cc/) runs in Chrome/Edge, connects to mBot/CyberPi/Codey Rocky over Web Bluetooth + WebSerial without a helper app ([Makeblock support](https://support.makeblock.com/hc/en-us/articles/19412317319191-Introduction-to-Direct-Connection-of-mBlock-5-on-the-web)). Block + Python.
- **Divergence:** account-required walled garden. Programs run on closed proprietary firmware. Hardware lock-in to Makeblock kits. No LLM, no replay, no recovery plane.
- **Better than us today:** scale (200k schools), educator curriculum, hardware breadth (CyberPi has its own screen + sensors), Chinese-market depth, multi-platform (PC/mobile/web).
- **Decision impact:** confirms Web-Bluetooth-from-browser is the dominant K-12 STEAM pattern, not contrarian. Reinforces the "no account, no proprietary kit" wedge: every major K-12 vendor (LEGO, Sphero, Makeblock) is account-gated and kit-locked. The combination "browser-paired AND user-owned hardware AND no account" remains unoccupied.

### MicroBlocks (microblocks.fun)
- **Competes for:** browser IDE to program a BLE/serial-connected microcontroller with blocks.
- **Overlap:** runs in Chrome/Edge via WebSerial + Web Bluetooth, no install; supports micro:bit, XRP, and others ([wiki.microblocks.fun](https://wiki.microblocks.fun/en/xrp_setup)). Live programming model.
- **Divergence:** pushes a VM to the device; programs run on-board. No LLM, no phone-human handoff, no replay. Single-device focus.
- **Better than us today:** live autocomplete / block editing against running firmware; a real educational community.
- **Decision impact:** closest architectural cousin. Validates "browser-first, no-account, BLE-capable" as a shipped pattern. Has no opinion on browser-as-brain for runtime.

### XRPCode / WPILib XRP (experientialrobotics.org)
- **Competes for:** cheap classroom robot + browser IDE — the tightest hardware-class analog.
- **Overlap:** browser IDE for the XRP (RP2040), Python + Blockly, no install ([WPILib docs](https://docs.wpilib.org/en/stable/docs/xrp-robot/web-ui.html)).
- **Divergence:** WiFi/WebSocket, not BLE-first — robot must be on the same network, which is exactly the classroom pain our BLE-first bet was designed around. Code runs on-robot. No LLM, no replay, no phone handoff.
- **Better than us today:** FRC-backed curriculum, ~$75 hardware, real classroom deployments.
- **Decision impact:** directly validates bet #1 — WiFi-first classroom stories *do* break.

### Viam
- **Competes for:** *closest framing rhyme.* Tagline "build robots like you build software" — same dev-environment-shape pitch, different audience and distribution model.
- **Overlap:** browser dashboard, camera streaming, live control ([viam.com](https://www.viam.com/product/platform-overview)). gRPC/WebRTC to a device-resident `viam-server`. Modular components, multi-language SDKs.
- **Divergence:** server-resident B2B cloud SaaS. `viam-server` fetches config from Viam cloud at startup ([docs.viam.com](https://docs.viam.com/operate/reference/viam-server/)). Different buyer (software engineer at an industrial outfit, fleet operator), different distribution shape (account-anchored cloud product vs. fork-and-run static site).
- **Better than us today:** data capture/sync, fleet management, funding, UR partnership.
- **Decision impact:** **inspiration, not competition.** Same transport stack we ship; treats the same problem space at industrial scale. Watching their feature surface tells us what becomes table-stakes for "robotics dev environment." Our distribution shape (browser-only, no backend, MIT, fork-and-run) is the moat — they can ship features in 18 months; restructuring their cloud-product distribution model to match would be a different company.

### Freedom Robotics
- **Competes for:** browser-based teleop and remote operation of fielded robots.
- **Overlap:** WebRTC video + control via browser; SDK/agent runs on the robot ([freedomrobotics.com](https://www.freedomrobotics.com/)).
- **Divergence:** server-resident B2B cloud SaaS, TURN-relay-anchored teleop, account + fleet model. No fork-and-run, no offline mode, no LLM/scripting surface.
- **Better than us today:** production teleop UX for industrial deployments, observability tooling, customer base in delivery + service robotics.
- **Decision impact:** same audience-shape conflict as Viam — enterprise/industrial vs. consumer/education/hobbyist. Worth tracking for transport / observability conventions; not a wedge threat.

### Improv Wi-Fi (open standard)
- **Competes for:** the onboarding moment — "how does a fresh device join Wi-Fi."
- **Overlap:** open standard for BLE-based Wi-Fi onboarding from a browser, Chrome/Edge ([improv-wifi.com](https://www.improv-wifi.com/)). Shipped across WLED, Tasmota, ESPHome.
- **Divergence:** explicitly scoped to Wi-Fi onboarding only — *"not the goal to offer a way for devices to share data or control."* Hands off to a device-hosted URL after provisioning.
- **Better than us today:** it's a *standard*, with network-effect adoption we don't have.
- **Decision impact:** **integration candidate, not a threat.** Our BLE onboarding characteristic could optionally speak Improv so any Improv-aware browser tool can provision our robots. See `@improv-wifi/sdk-js` on npm.

### ESP RainMaker
- **Competes for:** "ESP32-based product with BLE provisioning and a dashboard to control it."
- **Overlap:** BLE provisioning for ESP32/S3/C3/C6 ([docs.rainmaker.espressif.com](https://docs.rainmaker.espressif.com/docs/sdk/rainmaker-base-sdk/DeviceManagement/provisioning/)).
- **Divergence:** cloud-account-anchored by design — user↔node mapping during provisioning, AWS Cognito underneath. Mobile-app first. No browser-first story, no LLM.
- **Better than us today:** Espressif-backed, production-scale cloud infra.
- **Decision impact:** confirms that in the ESP32 ecosystem, the dominant BLE-provisioning story still assumes cloud + account + phone app. The "browser tab, no account, no server" stance remains differentiated.

### LeRobot (Hugging Face)
- **Competes for:** open-source stack to put an LLM/VLA brain on a robot.
- **Overlap:** LLM/VLA orchestration for hobby+research robots; v0.5 added Pi0-FAST, Real-Time Chunking, EnvHub ([HF blog](https://huggingface.co/blog/lerobot-release-v050), March 2026).
- **Divergence:** Python stack, GPU-assumed, imitation/RL-focused. No BLE story, no browser runtime, no classroom onboarding. Arms + manipulation, not browser-paired hobby robots.
- **Better than us today:** actual VLA models, datasets, research community.
- **Decision impact:** adjacent, not competitive — the "not real-time, not spatially aware, decision loop is seconds" scope line keeps us in a different lane. Potential future integration: `scripts.js` calling LeRobot policies client-side via transformers.js.

## Out of scope (one-liners)

- **Wokwi** — browser simulator, not a real-device pairing UI.
- **esptool-js / ESP Web Tools** — WebSerial flashers. Dependencies of the neighborhood, not competitors; we already rely on the same Web Serial API for recovery.
- **MakeCode micro:bit** — mature web IDE for micro:bit; overlaps MicroBlocks, adds little new signal.
- **Particle Device OS** — BLE provisioning exists but mobile-SDK oriented, commercial product flow, account-anchored. Same shape as RainMaker.
- **ROS 2 MoveIt, Dora-rs, industrial / arm stacks** — different buyer, different latency bracket, no browser pairing story. "Not real-time, not spatially aware" rules the lane out.
- **VEX IQ/V5, ROBOTIS** — proprietary-kit + proprietary-app lane. Doubly unavailable to the "no accounts, no server" thesis.

## Concluding read

**Is there a clean head-on competitor for the actual shape — *write code for a robot in a browser tab, no install, AI assist optional, fork-and-run*?** No. The closest cousins split the problem: **MicroBlocks** and **XRPCode** own browser-IDE-to-hardware but deploy code *to* the device and have no in-browser AI layer; **LEGO SPIKE**, **Sphero EDU**, and **Makeblock mBlock** own classroom-web-app experience but are walled gardens with accounts and proprietary kits; **Viam** and **Freedom Robotics** are the closest framing rhymes (server-resident dev environments for robots) but anchor to industrial cloud, accounts, and fleet ops; **ESP RainMaker** and **Improv Wi-Fi** own the BLE-provisioning primitive but stop there; **LeRobot** owns the VLA/LLM orchestration layer but has no browser runtime or BLE story.

**Does anything here say change direction?** No. The nearest tactical move is to implement the **Improv Wi-Fi** BLE onboarding characteristic alongside ours so anything Improv-aware (ESPHome Dashboard, WLED config, Home Assistant tools) can provision our robots out of the box. Interop win, not a strategy shift.

**What's the moat, given the landscape?** Ranked by erosion runway (slowest first):
- **Browser-native dev surface.** Write code in a tab, no install, no SDK download. Every "robotics platform" worth naming requires *some* install — `viam-server`, ESP-IDF, gpiozero on Pi, the Arduino IDE. The fork-and-run static-site distribution model is structurally hard to copy without restructuring a whole company's product surface.
- **Browser-resident model serving.** Open-vocab detector, ArUco fiducial pose, local LFM2 planner fallback — all client-side. No GPU server, no inference bill, no cloud-API dependency. Viam, Freedom Robotics, and LeRobot all assume server-side or per-device GPU. The combination "browser IDE + browser ML inference" is the shape no one is shipping.
- **Layered safety.** Firmware-bounded motors that the IDE-level planner (user code or Pip) can't bypass. Ask-human as the terminal cascade rung. Standard practice in driving (openpilot-panda) but rare in hobby/classroom robotics.
- **Fork-and-run.** GitHub-Pages deployable, no backend, no accounts, no data leaving the browser. MIT-licensed. Sphero, Viam, Particle, RainMaker, Freedom — all account-anchor.

Keep the scope lines loud in the README. The market reads "robotics platform" and expects Sphero (closed, accountful, kid-friendly) or Viam (cloud, engineer-facing, fleet-y). The project is neither. Naming what it *isn't* — *not a teleop dashboard, not a fleet manager, not "AI does everything autonomously," not real-time, not spatially aware* — does more positioning work than any feature comparison could.

## Sources

- [Schematik.io homepage](https://schematik.io)
- [LEGO Education SPIKE — Web Bluetooth + Web Serial (Chrome for Developers)](https://developer.chrome.com/blog/lego-education-spike-web-bluetooth-web-serial)
- [Sphero EDU Web App — Connecting Robots](https://help.sphero.com/sphero-support/connecting-robots-in-the-sphero-edu-web-app)
- [mBlock 5 web IDE](https://ide.mblock.cc/)
- [Makeblock support — direct browser connection](https://support.makeblock.com/hc/en-us/articles/19412317319191-Introduction-to-Direct-Connection-of-mBlock-5-on-the-web)
- [MicroBlocks XRP setup (Web Bluetooth)](https://wiki.microblocks.fun/en/xrp_setup)
- [MicroBlocks in the browser](http://www.microblocks.fun/en/microblocks_in_browser)
- [WPILib XRP Web UI](https://docs.wpilib.org/en/stable/docs/xrp-robot/web-ui.html)
- [Experiential Robotics XRP Code](https://www.experiential.bot/code)
- [Viam Platform Overview](https://www.viam.com/product/platform-overview)
- [viam-server reference](https://docs.viam.com/operate/reference/viam-server/)
- [Freedom Robotics homepage](https://www.freedomrobotics.com/)
- [Improv Wi-Fi homepage](https://www.improv-wifi.com/)
- [ESPHome 2025.10.0 changelog — Improv BLE improvements](https://esphome.io/changelog/2025.10.0/)
- [ESP RainMaker provisioning docs](https://docs.rainmaker.espressif.com/docs/sdk/rainmaker-base-sdk/DeviceManagement/provisioning/)
- [ESP RainMaker homepage](https://rainmaker.espressif.com/)
- [LeRobot v0.5.0 release notes (HF blog, Mar 2026)](https://huggingface.co/blog/lerobot-release-v050)
- [Particle BLE provisioning reference](https://docs.particle.io/reference/device-os/bluetooth-le/)
- [esptool-js (Espressif)](https://github.com/espressif/esptool-js)
- [LOFI Control (Web Bluetooth PWA for micro:bit)](https://cardboard.lofirobot.com/lofi-control-app-info/)

---

# Pip's proactive messages come from project state, not external feeds

No scheduled pipeline scraping external robotics sources (X, Reddit, HN, ArXiv, Hackaday RSS) and dripping them into the dashboard as "here's what's new." No notification backend, no content channel.

## What we do instead

Pip's proactive messages are situational observations from state the dashboard already has. Match a colleague leaning over your desk saying *"hey, I notice X,"* not a newsletter.

Inputs, all same-origin, all already in the browser:

- Replay records (`replay.js`) — what Pip has been asked to do lately, what errored, what never completed.
- Robot telemetry — firmware version drift, last-seen timestamps, which robots are `firmware-down` vs `connected`, which capabilities have never been exercised.
- User scripts (`scripts.js` + localStorage) — scripts saved but never run, scripts that errored on last run, scripts related to a stalled goal.
- Project intent — `.claude/CLAUDE.md` (wedge + anti-drift guards) and `.claude/working.md` when present. The user's own statement of what they're trying to build is the highest-signal input.

One short observation at a time, tied to a user-activity boundary (session start, session end, robot reconnect after > 24h), not a wall-clock cron. Dismissable without consequence.

Shape examples:

```
Your "line-follow" script errored on BLE drop last Thursday.
Heartbeat shipped — worth retrying?

You've paired Pi-03 twice but never opened the camera capability.
Want me to walk through grounding?

Firmware on Pi-01 is 4 versions behind. New pulse caps landed in
between — OTA when convenient?
```

Each one names a *specific* thing *this user* did or didn't do. That's the signal a generic feed can't carry.

## Why this is the right shape

Pip runs in the browser; every input that would meaningfully change what Pip says is also in the browser, or one `fetch()` away in `.claude/*.md`. Putting signal source on a schedule outside the browser separates thinking from data and pays the cost of keeping them in sync.

What you get for free:

- **Zero new infrastructure.** No cron, no scraper, no CI job, no JSON corpus, no filter pipeline. Just `assistant.js` plus a small observation reader for existing state.
- **Zero new trust boundary.** Same-origin reads of the dashboard's own stores. Nothing crosses the network that doesn't already cross it.
- **High signal by construction.** An observation referencing the user's own script by name clears the "is this relevant?" bar before it's written. A trending-reddit link does not.
- **Dismissal is free.** Observations are ephemeral; ignoring one costs nothing and doesn't build unread debt.

## The failure mode this avoids

"Give Pip a feed so the messages aren't boring" is the engagement reflex every newsletter SaaS has tried: push content on a schedule, hope relevance averages out. Generic feeds get ignored for the same reason technical notifications get ignored: the user pays a translation cost from *"someone built X"* to *"does this matter for me right now?"* That translation cost kills engagement, not content cost.

Shipping a scheduled content pipeline *before* the state-aware layer exists pays pipeline maintenance for output the state-aware messaging would dominate on relevance anyway. Build the floor first.

## When would an external feed earn its way in?

Only when the state-aware layer saturates — when Pip has mined what the browser knows and the ceiling becomes *"Pip doesn't know about the new ESP32-S3 cam module that would unblock the perception loop."* At that point:

1. Add a GitHub Action on the `pulse` pattern — public-API-only, no-auth, committing JSON to `public/feed/`. Sources that fit: Reddit `.json`, HN Algolia, GitHub trending by topic, Hackaday/Adafruit/Sparkfun RSS, ArXiv. **Not X**: free tier died.
2. Feed is a **secondary input to the same filter** that already reads project state. Filter stays in the browser. The GitHub Action is dumb by design; intelligence stays where iteration is cheap.
3. Observations referencing external content still have to clear *"and here's why it matters for your current work."* A raw trending item never surfaces on its own.

Order matters: state-aware layer first, let it saturate, then add the corpus. Skipping to the feed is the classic "we built the pipeline before we knew what we were filtering for."

---

# Wired but unproven — pending real-world validation

Things that exist in the tree and load at runtime but haven't been confirmed end-to-end against actual hardware. Kept out of `README.md`, `DEV.md`, and the GitHub repo About so we don't promise what we can't demo. Promote into user docs only after a real run confirms the path.

## Overhead ArUco localization (`public/aruco.js`)

**What's wired.**
- Headless detection service — no UI panel. Helper-card "Camera role" select on each paired phone offers `Operator / Overhead localization / Mount on <robot>`. Choosing Overhead sets `settings.arucoOverheadPhoneId` (persisted) and points the detection loop at that phone's existing preview tile in the helpers card. No second video element, no second decoder.
- SVG overlay paints detected markers directly on the helper's preview (`patchArucoOverlay`-style — same shape as the deleted phone-on-robot tracker, retargeted at the helpers tile).
- Detection via `js-aruco2` from jsDelivr (`cv.js` + `aruco.js` + `posit1.js`), dictionary `ARUCO_4X4_50`. Printable marker sheets in `public/assets/aruco_markers_0.pdf` and `_1.pdf`. Pose via `POS.Posit` using `settings.arucoMarkerSizeMm` + focal-length heuristic (`max(w,h) * 0.85`) — no calibration file.
- Marker → robot binding: prefers explicit `entry.arucoMarkerId` (persisted in localStorage; set via `window.bindArucoMarker(robotId, markerId)`). Falls back to positional `entries[m.id]` only when NO entry has claimed that id. Hits write `entry.arucoPosition = { x, y, headingDeg, markerSizeMm, updatedAt }`.

**What hasn't been confirmed.**
- Whether the focal-length heuristic gives metric accuracy within a useful tolerance against a real ruler (anywhere from "perfect" to "off by 30%" is plausible without ground-truth measurement).
- Whether ARUCO_4X4_50 detection holds reliably on a phone-camera feed via WebRTC (compression, autofocus hunting, rolling-shutter under motion).
- Multi-robot orchestration end-to-end: two robots, two markers, two bindings, both `arucoPosition`s update on the same scan, motion planner consumes both without drift. This is the wedge demo for the primitive.

**To validate.** Print sheet 0 + sheet 1, tape marker 0 on Pi-01 and marker 1 on Pi-02. Pair a phone, share its camera, set role to "Overhead localization." Bind explicitly: `window.bindArucoMarker("<pi-01-id>", 0)` and `window.bindArucoMarker("<pi-02-id>", 1)`. Confirm both robots' `arucoPosition` update simultaneously on each detection, metric XY within ~20 mm of tape-measured ground truth at ~50 cm camera height. If it holds, promote: line in `README.md` perception section, bullet in `DEV.md` "When to reach for what."

**Why bother.** Sub-pixel deterministic pose for a tagged object is the only primitive on the roadmap that closes the visual-servo loop without a depth sensor — and it's the substrate for the multi-robot-orchestration direction in `.claude/CLAUDE.md`. Drives `entry.arucoPosition` which the motion controller consumes as ground truth (subject to its staleness gate — `aruco.js` does NOT clear stale entries when a robot leaves frame; that's the consumer's job).

## YOLO26n closed-vocab detector (not built)

Considered as a faster sibling to Grounding DINO for reactive-tier use cases (visual servo, gamepad-overlay tracking). No `yolo.js` exists. Don't promise this in any external surface until it ships *and* validates against a real use case that Grounding DINO can't already serve.

The "detector eval mode" pattern (swap detectors on the same frame, render side-by-side, replay) is genuinely interesting infrastructure — but only earns its way in when there are two backends worth comparing. Right now there is one.
