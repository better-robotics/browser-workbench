// Expected schema shape:
//   { name: "snapshot", type: "ble-snapshot" }
// Pairs a write-trigger char with a notify-out chunked stream. Same envelope
// the OTA path uses (just outbound here): 0x01 begin+u32 len, 0x02 chunk,
// 0x03 commit, 0xff err+text. ~10-30 KB JPEG over BLE → ~1-2s per shot.
import { UUIDS_BY_CAP } from "../../ble.js";
import { escapeHtml } from "../../dom.js";
import { logFor } from "../../log.js";

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

export function makeBleSnapshotCap(schema) {
  const { name } = schema;
  const chars = schema.chars || UUIDS_BY_CAP[name];
  const reqChar  = chars.request;
  const dataChar = chars.data;
  const reqField    = `${name}ReqChar`;
  const dataField   = `${name}DataChar`;
  const bufField    = `${name}Buf`;       // accumulator
  const totalField  = `${name}Total`;     // expected size from begin opcode
  const recvField   = `${name}Recv`;      // bytes received so far
  const urlField    = `${name}Url`;       // last successful data URL
  const errField    = `${name}Err`;
  const busyField   = `${name}Busy`;      // a transfer is in flight
  const action      = `${name}-take`;
  const label = name[0].toUpperCase() + name.slice(1);

  return {
    name,
    schema,
    initEntry: () => ({
      [reqField]: null, [dataField]: null,
      [bufField]: null, [totalField]: 0, [recvField]: 0,
      [urlField]: null, [errField]: null, [busyField]: false,
    }),

    async probe(entry, service) {
      try {
        entry[reqField]  = await service.getCharacteristic(reqChar);
        entry[dataField] = await service.getCharacteristic(dataChar);
        await entry[dataField].startNotifications();
        entry[dataField].addEventListener("characteristicvaluechanged", (e) => {
          const data = new Uint8Array(e.target.value.buffer);
          if (data.length === 0) return;
          const op = data[0];
          if (op === 0x01 && data.length >= 5) {
            // begin: u32 BE total
            const total = (data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4];
            entry[bufField] = new Uint8Array(total);
            entry[totalField] = total;
            entry[recvField] = 0;
            entry[errField] = null;
            entry[busyField] = true;
            renderEntry(entry);
          } else if (op === 0x02 && entry[bufField]) {
            const payload = data.subarray(1);
            const room = entry[totalField] - entry[recvField];
            const take = Math.min(payload.length, room);
            entry[bufField].set(payload.subarray(0, take), entry[recvField]);
            entry[recvField] += take;
            renderEntry(entry);
          } else if (op === 0x03 && entry[bufField]) {
            // commit: turn the accumulated bytes into a data URL we can <img>.
            // The protocol is JPEG-only on the firmware side; assume it.
            const blob = new Blob([entry[bufField]], { type: "image/jpeg" });
            // Revoke prior url so we don't accumulate refs across snapshots.
            if (entry[urlField]) URL.revokeObjectURL(entry[urlField]);
            entry[urlField] = URL.createObjectURL(blob);
            entry[bufField] = null;
            entry[busyField] = false;
            logFor(entry, `snapshot: ${entry[recvField]} bytes`);
            renderEntry(entry);
          } else if (op === 0xff) {
            const msg = new TextDecoder().decode(data.subarray(1));
            entry[errField] = msg || "snapshot failed";
            entry[bufField] = null;
            entry[busyField] = false;
            logFor(entry, `snapshot error: ${entry[errField]}`);
            renderEntry(entry);
          }
        });
      } catch {
        entry[reqField] = entry[dataField] = null;
      }
    },

    cleanup(entry) {
      if (entry[urlField]) { URL.revokeObjectURL(entry[urlField]); entry[urlField] = null; }
      entry[reqField] = entry[dataField] = null;
      entry[bufField] = null;
      entry[busyField] = false;
    },

    renderSection(entry) {
      if (entry.status !== "connected" || !entry[reqField]) return "";
      const busy = entry[busyField];
      const url = entry[urlField];
      const err = entry[errField];
      const progress = busy && entry[totalField]
        ? ` · ${entry[recvField]} / ${entry[totalField]} B`
        : "";
      const img = url
        ? `<img class="robot-camera" src="${escapeHtml(url)}" alt="snapshot">`
        : "";
      const errLine = err ? `<div class="meta" style="color:var(--danger);">${escapeHtml(err)}</div>` : "";
      return `
        <div class="robot-controls">
          <div class="row">
            <div>
              <div class="label">${escapeHtml(label)}</div>
              <div class="meta">BLE-only · works without WiFi${progress}</div>
            </div>
            <button class="secondary sm" data-action="${action}" ${busy ? "disabled" : ""}>${busy ? "Capturing…" : "Take photo"}</button>
          </div>
          ${img}
          ${errLine}
        </div>
      `;
    },

    wireActions(entry, node) {
      const btn = node.querySelector(`[data-action="${action}"]`);
      if (!btn) return;
      btn.addEventListener("click", async () => {
        if (!entry[reqField] || entry[busyField]) return;
        entry[errField] = null;
        try {
          await entry[reqField].writeValueWithResponse(Uint8Array.of(0x01));
        } catch (err) {
          entry[errField] = err.message || String(err);
          renderEntry(entry);
        }
      });
    },
  };
}
