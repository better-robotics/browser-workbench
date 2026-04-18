// Admin capability — out-of-band ops for when BLE is alive but the robot's
// service is stuck. Currently one opcode: restart the pi-robot.service.
// Useful for "soft-stuck" cases (install completed but new imports are weird,
// a capability crashed but the BLE stack is alive, etc.). Does NOT help when
// the service is entirely dead — that needs SSH or a power cycle.
import { ADMIN_CHAR_UUID } from "../ble.js";
import { logFor } from "../log.js";
import { state } from "../state.js";

const ADMIN_OP_RESTART = 0x01;

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

export async function restartService(id) {
  const entry = state.devices.get(id);
  if (!entry?.adminChar) {
    logFor(entry || { name: "?", lastEvent: null }, "restart unavailable on this robot");
    return;
  }
  if (!confirm(
    `Restart the robot's service?\n\nThis disconnects BLE briefly; the ` +
    `dashboard will reconnect once the service is back (~5–10 s).`
  )) return;
  try {
    await entry.adminChar.writeValueWithResponse(new Uint8Array([ADMIN_OP_RESTART]));
    logFor(entry, "service restart requested");
  } catch (err) {
    logFor(entry, `restart write failed: ${err.message}`);
  }
}

export const admin = {
  name: "admin",
  initEntry: () => ({ adminChar: null }),
  async probe(entry, service) {
    try {
      entry.adminChar = await service.getCharacteristic(ADMIN_CHAR_UUID);
    } catch {
      entry.adminChar = null;
    }
  },
  cleanup(entry) { entry.adminChar = null; },
  renderSection() { return ""; },
  wireActions() {},
};
