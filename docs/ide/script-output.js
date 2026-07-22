// Browser side of the on-robot Python VM's output stream (firmware: pyvm.c ->
// SCRIPT_OUTPUT). Each notify leads with a 1-byte opcode: TEXT is UTF-8 stdout
// as the script runs, DONE ends a clean run, ERROR carries the traceback of an
// uncaught exception. One handler per robot (one run at a time); the runner
// (script-runner.js) registers it, ble-lifecycle pumps notifications in here.
import { SCRIPT_OUT_TEXT, SCRIPT_OUT_DONE, SCRIPT_OUT_ERROR } from "../protocol-constants.js";

const _handlers = new Map(); // robotId -> { onText, onDone, onError }

// Register the active run's handler. Returns an unregister fn.
export function setScriptOutputHandler(robotId, handler) {
  _handlers.set(robotId, handler);
  return () => { if (_handlers.get(robotId) === handler) _handlers.delete(robotId); };
}

export function ingestScriptOutput(entry, dv) {
  const data = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  if (data.length === 0) return;
  const h = _handlers.get(entry.id);
  if (!h) return;
  const text = () => new TextDecoder().decode(data.subarray(1));
  switch (data[0]) {
    case SCRIPT_OUT_TEXT:  h.onText?.(text());  break;
    case SCRIPT_OUT_DONE:  h.onDone?.();        break;
    case SCRIPT_OUT_ERROR: h.onError?.(text()); break;
  }
}
