// Pip's face on the phone screen when mounted on a robot. The phone
// bezel is the head; the screen is the face. Cozmo / Vector lineage:
// two rounded-rect eyes that change shape per emotional state. Eye
// geometry does all the work — no mouth, no extra anatomy, no
// pre-rendered animation assets.
//
// Each state is a pair of CSS `transform` strings (left eye, right eye)
// applied to the SVG rects; transition on `transform` and `opacity`
// smooths the morph. Some states are transient (auto-revert to idle on
// a timer); others persist until explicitly cleared. Idle schedules
// jittered blinks so the face never feels frozen.
//
// State source is the desktop's pip-event stream (phones.js
// sendPipFaceEvent), driven by tool-call dispatch in assistant.js and
// watcher-fire events. Phone owns rendering; desktop owns events.

const STATES = {
  idle:       { l: "",                              r: "",                              opacity: 1   },
  blink:      { l: "scaleY(0.08)",                  r: "scaleY(0.08)",                  opacity: 1   },
  scan_left:  { l: "translateX(-24px)",             r: "translateX(-24px)",             opacity: 1   },
  scan_right: { l: "translateX(24px)",              r: "translateX(24px)",              opacity: 1   },
  look_up:    { l: "translateY(-16px)",             r: "translateY(-16px)",             opacity: 1   },
  look_down:  { l: "translateY(14px)",              r: "translateY(14px)",              opacity: 1   },
  think:      { l: "translateY(-12px) scale(0.85)", r: "translateY(-12px) scale(0.85)", opacity: 1   },
  alert:      { l: "scale(1.3, 1.25)",              r: "scale(1.3, 1.25)",              opacity: 1   },
  ask:        { l: "rotate(-12deg)",                r: "rotate(12deg)",                 opacity: 1   },
  happy:      { l: "scale(1.15, 0.22)",             r: "scale(1.15, 0.22)",             opacity: 1   },
  halted:     { l: "scale(0.55, 0.4)",              r: "scale(0.55, 0.4)",              opacity: 0.5 },
  sleepy:     { l: "translateY(8px) scaleY(0.5)",   r: "translateY(8px) scaleY(0.5)",   opacity: 0.8 },
};

let _container = null;
let _leftEye = null;
let _rightEye = null;
let _state = "idle";
let _stateTimer = null;
let _blinkTimer = null;
let _scanTimer = null;

export function mountPipFace(container) {
  _container = container;
  // 200×240 portrait viewBox sized for a phone in portrait orientation.
  // Eyes are 50×70 rects centered at (65, 120) and (135, 120). The 20px
  // gap reads as "two eyes," not "one wide blob," at any zoom level.
  // transform-box: fill-box makes transform-origin work on SVG shapes
  // without manual cx/cy bookkeeping.
  container.innerHTML = `
    <svg class="pip-face-svg" viewBox="0 0 200 240" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <rect class="pip-face-eye pip-face-eye-l" x="40" y="85" width="50" height="70" rx="25" ry="25" />
      <rect class="pip-face-eye pip-face-eye-r" x="110" y="85" width="50" height="70" rx="25" ry="25" />
    </svg>
  `;
  _leftEye = container.querySelector(".pip-face-eye-l");
  _rightEye = container.querySelector(".pip-face-eye-r");
  setFaceState("idle");
  _scheduleBlink();
}

export function unmountPipFace() {
  _clearTimers();
  if (_container) _container.innerHTML = "";
  _container = null;
  _leftEye = null;
  _rightEye = null;
  _state = "idle";
}

function _clearTimers() {
  if (_stateTimer) { clearTimeout(_stateTimer); _stateTimer = null; }
  if (_blinkTimer) { clearTimeout(_blinkTimer); _blinkTimer = null; }
  if (_scanTimer)  { clearInterval(_scanTimer); _scanTimer = null; }
}

function _applyTarget(name) {
  const t = STATES[name] || STATES.idle;
  if (!_leftEye || !_rightEye) return;
  _leftEye.style.transform = t.l;
  _rightEye.style.transform = t.r;
  _leftEye.style.opacity = t.opacity;
  _rightEye.style.opacity = t.opacity;
}

// Public state-setter. `transient_ms` auto-reverts to idle after the
// duration. Use it for momentary expressions (blink, alert, happy).
// State changes cancel any pending blink — a blink scheduled to fire
// during an "alert" expression would visually fight the alert.
export function setFaceState(name, { transient_ms = 0 } = {}) {
  if (!_leftEye) return;
  _clearTimers();
  _state = name;
  _applyTarget(name);
  if (transient_ms > 0) {
    _stateTimer = setTimeout(() => setFaceState("idle"), transient_ms);
  } else if (name === "idle") {
    _scheduleBlink();
  } else if (name === "scan") {
    // Scan is a composite — alternates scan_left / scan_right on a
    // ~600ms cadence. The "scan" name persists in _state so the next
    // setFaceState call cleanly stops the oscillation.
    let dir = true;
    const tick = () => {
      if (_state !== "scan") return;
      _applyTarget(dir ? "scan_left" : "scan_right");
      dir = !dir;
    };
    tick();
    _scanTimer = setInterval(tick, 600);
  }
}

// Auto-blink: random 2–5s after entering idle. Cancelled on state
// change. Without it the face looks frozen between events.
function _scheduleBlink() {
  if (_state !== "idle") return;
  const delay = 2000 + Math.random() * 3000;
  _blinkTimer = setTimeout(() => {
    if (_state !== "idle") return;
    _applyTarget("blink");
    setTimeout(() => {
      if (_state !== "idle") return;
      _applyTarget("idle");
      _scheduleBlink();
    }, 140);
  }, delay);
}

// Desktop-emitted pip-event → face state. Centralized so the mapping
// is one place: when we change which tool maps to which expression,
// only this function changes. tool_result events return to idle for
// most tools (the next tool_call sets a new state); ask_human is the
// exception — it leaves the face in "ask" until the operator answers.
export function applyPipEvent(event, data = {}) {
  if (!_leftEye) return;
  switch (event) {
    case "tool_call": {
      const tool = data.tool || "";
      const input = data.input || {};
      switch (tool) {
        case "move_motor":
        case "drive_distance_cm":
        case "drive_arc":
        case "approach_until": {
          const l = Number(input.l ?? input.cm ?? input.speed ?? 0);
          const r = Number(input.r ?? input.cm ?? input.speed ?? 0);
          if (l > r + 10) setFaceState("scan_right");
          else if (r > l + 10) setFaceState("scan_left");
          else if ((l < 0) || (Number(input.cm) < 0)) setFaceState("look_down");
          else setFaceState("look_up");
          return;
        }
        case "get_robot_detections":
          setFaceState("scan");
          return;
        case "view_robot_frame":
          setFaceState("think", { transient_ms: 1800 });
          return;
        case "ask_human":
        case "ask_human_via_phone":
          setFaceState("ask");
          return;
        case "speak":
          setFaceState("happy", { transient_ms: 800 });
          return;
        case "start_robot_camera":
        case "start_robot_watcher":
          setFaceState("blink", { transient_ms: 200 });
          return;
        case "stop":
        case "stop_robot_watcher":
          setFaceState("halted", { transient_ms: 1200 });
          return;
      }
      return;
    }
    case "tool_result": {
      // Most tool results restore idle so the next tool's state shows
      // cleanly. Keep "ask" persistent (cleared by the answer event).
      if (data.tool === "ask_human" || data.tool === "ask_human_via_phone") return;
      if (data.error || data.ok === false) {
        setFaceState("halted", { transient_ms: 1500 });
      } else {
        setFaceState("idle");
      }
      return;
    }
    case "watcher_fire":
      setFaceState("alert", { transient_ms: 700 });
      return;
    case "watcher_clear":
      setFaceState("happy", { transient_ms: 500 });
      return;
    case "idle":
      setFaceState("idle");
      return;
  }
}
