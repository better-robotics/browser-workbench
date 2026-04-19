// Generic typed-characteristic runtime for `toggle` capabilities.
// Zero JS code per capability of this type — pass in a schema entry from
// fw-info.caps and get back the standard { probe, cleanup, renderSection,
// wireActions } object. Adding a new boolean characteristic to a robot
// becomes one schema entry + nothing else on the dashboard side.
//
// Expected schema shape:
//   { name: "led", char: "…d92", type: "toggle" }
//
// State lives on `entry[<name>Char]` (BLE char handle) and `entry[<name>On]`
// (current bool). Same field-name convention the previous hand-written LED
// module used, so anything reading `entry.ledOn` keeps working.
import { escapeHtml } from "../../dom.js";
import { logFor } from "../../log.js";

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

// Generic helper for anything that needs to flip a toggle cap by name.
// Voice commands, scripts, LLM tool calls all go through this path.
export async function setToggleValue(entry, capName, value) {
  const ch = entry[`${capName}Char`];
  if (!ch) return;
  try {
    await ch.writeValueWithResponse(Uint8Array.of(value ? 1 : 0));
    entry[`${capName}On`] = !!value;
    renderEntry(entry);
  } catch (err) {
    logFor(entry, `${capName} write failed: ${err.message}`);
  }
}

export async function toggleCapValue(entry, capName) {
  return setToggleValue(entry, capName, !entry[`${capName}On`]);
}

export function makeToggleCap(schema) {
  const { name, char } = schema;
  const charField = `${name}Char`;
  const onField = `${name}On`;
  const action = `toggle-${name}`;
  // Capitalize once so the label reads "LED" / "Light" / "Heater" — not
  // "led" / "light" / "heater".
  const label = name.length <= 3 ? name.toUpperCase()
    : name[0].toUpperCase() + name.slice(1);

  return {
    name,
    schema,
    initEntry: () => ({ [charField]: null, [onField]: false }),

    async probe(entry, service) {
      try {
        const ch = await service.getCharacteristic(char);
        entry[charField] = ch;
        const v = await ch.readValue();
        entry[onField] = v.getUint8(0) !== 0;
        await ch.startNotifications();
        ch.addEventListener("characteristicvaluechanged", (e) => {
          entry[onField] = e.target.value.getUint8(0) !== 0;
          renderEntry(entry);
          logFor(entry, `${name} → ${entry[onField] ? "on" : "off"}`);
        });
      } catch {
        entry[charField] = null;
      }
    },

    cleanup(entry) { entry[charField] = null; },

    renderSection(entry) {
      if (entry.status !== "connected" || !entry[charField]) return "";
      const on = entry[onField];
      return `
        <div class="robot-controls row">
          <div>
            <div class="label">${escapeHtml(label)}</div>
            <div class="meta">${on ? "on" : "off"}</div>
          </div>
          <button class="secondary sm" data-action="${action}">${on ? "Turn off" : "Turn on"}</button>
        </div>
      `;
    },

    wireActions(entry, node) {
      const btn = node.querySelector(`[data-action="${action}"]`);
      if (btn) btn.addEventListener("click", () => toggleCapValue(entry, name));
    },
  };
}
