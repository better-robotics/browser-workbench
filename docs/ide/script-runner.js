// Run a Python script on a robot's embedded VM (issue #47). The browser is the
// author + shipper: write the file to /fs (the file service), fire the
// script-run op, and stream the VM's stdout/traceback back. No browser-side
// execution — the code runs on the robot.
import { writeFile, fsAvailable } from "../fs/fs-client.js";
import { sendCommand } from "../capabilities/runtime/command.js";
import { setScriptOutputHandler } from "./script-output.js";

// True when this robot can run Python: it mounted the file service AND
// advertises the "python" capability (S3 boards with the VM firmware).
export function pyCapable(entry) {
  if (!entry || entry.status !== "connected" || !fsAvailable(entry)) return false;
  return (entry.capSchema || []).some((c) => c.name === "python");
}

// Ship `body` as /fs/<name>, run it, and stream output through the callbacks.
// Resolves with a handle exposing stop(). onDone/onError fire once, terminal.
export async function runOnRobot(entry, name, body, { onText, onDone, onError } = {}) {
  await writeFile(entry, name, body);

  let settled = false;
  const finish = (fn, arg) => { if (settled) return; settled = true; unsub(); fn?.(arg); };
  const unsub = setScriptOutputHandler(entry.id, {
    onText: (t) => onText?.(t),
    onDone: () => finish(onDone),
    onError: (tb) => finish(onError, tb),
  });

  const sent = await sendCommand(entry, "ops", { op: "script-run", args: { name } });
  if (!sent) { unsub(); throw new Error("script-run write failed (robot disconnected?)"); }

  return {
    async stop() {
      try { await sendCommand(entry, "ops", { op: "script-stop", args: {} }); } catch {}
      finish(onDone);
    },
  };
}
