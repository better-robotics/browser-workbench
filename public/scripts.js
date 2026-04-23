// User scripts run in the browser, not on the Pi. See USER-CODE.md.
//
// The robot API mirrors the BLE capability surface. Motor writes go through
// pulseMotors (pulse-bounded ±40 / 50–2000ms), same caps the LLM is bound by
// — user scripts are "another planner" under the same control-loop invariants
// as Pip. See .claude/CLAUDE.md → Control-loop invariants.
import { $ } from "./dom.js";
import { state } from "./state.js";
import { setToggleValue } from "./capabilities/runtime/toggle.js";
import { pulseMotors } from "./capabilities/runtime/signed-pair.js";
import { sendCommand } from "./capabilities/runtime/command.js";

const STORE_KEY = "better-robotics:scripts:v1";
const DEFAULT_BODY = `// Edit and click Run. \`robots\` is every connected robot;
// \`robot\` is the first one. \`sleep(ms)\` and \`log(...)\` are
// available. The robot API matches the BLE capability surface
// — see USER-CODE.md.

if (!robot) {
  log("No robots connected. Pair one and click Connect first.");
  return;
}

log(\`Driving \${robot.name}…\`);
await robot.move({ left: 30, right: 30, durationMs: 400 });
await sleep(500);
await robot.move({ left: -30, right: -30, durationMs: 400 });
log("done");
`;

let _wired = false;
let _running = false;

function loadBody() {
  try { return localStorage.getItem(STORE_KEY) ?? DEFAULT_BODY; }
  catch { return DEFAULT_BODY; }
}

function saveBody(body) {
  try { localStorage.setItem(STORE_KEY, body); } catch {}
}

// Per-robot wrapper. Methods are thin pass-throughs to the existing capability
// surface — same code path the dashboard UI uses, so safety/clamp behavior is
// identical.
function makeRobotApi(entry) {
  return {
    id: entry.id,
    name: entry.name,
    get connected() { return entry.status === "connected"; },
    get capabilities() { return (entry.capSchema || []).map(c => c.name); },
    entry,

    async move({ left = 0, right = 0, durationMs = 400 } = {}) {
      return pulseMotors(entry.id, left, right, durationMs);
    },

    async led(on) {
      if (!entry.ledChar) throw new Error(`${entry.name}: no LED capability`);
      await setToggleValue(entry, "led", on);
    },

    async op(name, args = {}) {
      // Fire-and-forget. Op responses (get-log, get-config) flow through the
      // dashboard's existing ops-response dispatcher, not back to this caller.
      return sendCommand(entry, "ops", { op: name, args });
    },
  };
}

function connectedRobots() {
  return [...state.devices.values()]
    .filter(e => e.status === "connected")
    .map(makeRobotApi);
}

function appendOutput(line) {
  const out = $("scripts-output");
  if (!out) return;
  const div = document.createElement("div");
  div.textContent = line;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}

async function runScript() {
  if (_running) return;
  _running = true;
  const runBtn = $("scripts-run");
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = "Running…"; }
  const out = $("scripts-output");
  if (out) out.innerHTML = "";
  const body = $("scripts-editor").value;
  saveBody(body);
  const log = (...args) => appendOutput(args.map(a =>
    typeof a === "string" ? a : JSON.stringify(a)
  ).join(" "));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const robots = connectedRobots();
  const robot = robots[0] || null;
  try {
    // AsyncFunction so `await` works at the top of the user's script.
    const fn = new (Object.getPrototypeOf(async function () {}).constructor)(
      "robot", "robots", "sleep", "log", body
    );
    const ret = await fn(robot, robots, sleep, log);
    if (ret !== undefined) appendOutput(`→ ${typeof ret === "string" ? ret : JSON.stringify(ret)}`);
  } catch (err) {
    appendOutput(`Error: ${err.message || err}`);
  } finally {
    _running = false;
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = "Run"; }
  }
}

export function openScriptsDialog() {
  const dlg = $("scripts-modal");
  $("scripts-editor").value = loadBody();
  dlg.showModal();
}

export function init() {
  if (_wired) return;
  _wired = true;
  $("scripts-close").addEventListener("click", () => $("scripts-modal").close());
  $("scripts-run").addEventListener("click", runScript);
  $("scripts-reset").addEventListener("click", () => {
    if (confirm("Reset script to the default example?")) {
      $("scripts-editor").value = DEFAULT_BODY;
      saveBody(DEFAULT_BODY);
    }
  });
  // Cmd/Ctrl-Enter to run from inside the editor.
  $("scripts-editor").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runScript();
    }
  });
}
