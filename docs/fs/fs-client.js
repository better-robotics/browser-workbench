// Browser side of the on-robot file service (firmware: main/fs_svc.c). Two
// characteristics carry a 1-byte opcode: FS_OP (we write control requests +
// write-session bytes) and FS_DATA (the board notifies a JSON reply stream
// and a binary file-read stream). Opcodes are the shared fs_transfer group
// from protocol/constants.json.
//
// Ops are serialized per robot behind a promise-chain mutex: a `read` sends
// a JSON header then a separate file stream, and a `write` is begin-ack →
// stream → commit-ack — making each high-level op atomic keeps every reply
// unambiguous (the board processes FS_OP writes serially regardless).
import {
  FS_OP_JSON, FS_OP_WBYTES,
  FS_RSP_BEGIN, FS_RSP_CHUNK, FS_RSP_END,
  FS_FILE_BEGIN, FS_FILE_CHUNK, FS_FILE_END,
} from "../protocol-constants.js";

// WBYTES payload per frame. Matches OTA's 244: the firmware FS_OP buffer is
// 256 B and the negotiated ATT MTU is 256 (max write payload 253), so
// 244 + 1 opcode byte clears both.
const WRITE_CHUNK = 244;

// Standard reflected CRC-32 (IEEE, poly 0xEDB88320 = reflection of
// 0x04C11DB7, init/final ~0 — matches zlib / Python's zlib.crc32). Must
// match crc32() in firmware/esp32_robot_idf/main/fs_svc.c byte-for-byte —
// the board rejects a write whose CRC disagrees.
export function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function ensureFs(entry) {
  if (!entry.fs) {
    entry.fs = { opChar: null, dataChar: null, lock: Promise.resolve(),
                 pending: null, rsp: null, file: null };
  }
  return entry.fs;
}

// Wire the characteristics (called from the BLE connect flow). Idempotent
// per connection; the notify listener routes FS_DATA into ingestFsData.
export function attachFs(entry, opChar, dataChar) {
  const fs = ensureFs(entry);
  fs.opChar = opChar;
  fs.dataChar = dataChar;
}

export function detachFs(entry) {
  if (!entry.fs) return;
  const p = entry.fs.pending;
  if (p) { clearTimeout(p.timer); p.reject(new Error("fs: disconnected")); }
  entry.fs = null;
}

export function fsAvailable(entry) {
  return !!(entry.fs && entry.fs.opChar && entry.fs.dataChar);
}

const u32be = (a, o) => ((a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3]) >>> 0;

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Route one FS_DATA notification. Reassembles the JSON reply stream and the
// binary file stream; resolves whatever op is pending.
export function ingestFsData(entry, dv) {
  const fs = entry.fs;
  if (!fs) return;
  const data = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  if (data.length === 0) return;
  switch (data[0]) {
    case FS_RSP_BEGIN: fs.rsp = []; break;
    case FS_RSP_CHUNK: if (fs.rsp) fs.rsp.push(data.slice(1)); break;
    case FS_RSP_END: {
      if (!fs.rsp) break;
      const text = new TextDecoder().decode(concat(fs.rsp));
      fs.rsp = null;
      let msg = null;
      try { msg = JSON.parse(text); } catch {}
      handleReply(fs, msg);
      break;
    }
    case FS_FILE_BEGIN: fs.file = []; break;
    case FS_FILE_CHUNK: if (fs.file) fs.file.push(data.slice(1)); break;
    case FS_FILE_END: {
      if (!fs.file) break;
      const bytes = concat(fs.file);
      fs.file = null;
      const p = fs.pending;
      if (p) finish(fs, () => p.resolve({ ...(p.header || {}), bytes }));
      break;
    }
  }
}

function handleReply(fs, msg) {
  const p = fs.pending;
  if (!p) return;
  if (!msg) { finish(fs, () => p.reject(new Error("fs: unparseable reply"))); return; }
  if (msg.ok === false) {
    const err = new Error(`fs ${msg.op}: ${msg.error || "failed"}`);
    err.fsCode = msg.error;
    finish(fs, () => p.reject(err));
    return;
  }
  // read: this JSON is the header ({op,ok,name,size}); the file stream
  // follows and resolves the op. Every other reply resolves here.
  if (p.expectFile) { p.header = msg; return; }
  finish(fs, () => p.resolve(msg));
}

// Clear the pending slot + timer, then run the settle callback.
function finish(fs, settle) {
  const p = fs.pending;
  if (p) clearTimeout(p.timer);
  fs.pending = null;
  settle();
}

// Serialize: acquire returns a release fn once prior ops have settled.
function acquire(fs) {
  let release;
  const next = new Promise((r) => { release = r; });
  const prev = fs.lock;
  fs.lock = next;
  return prev.then(() => release);
}

function frameJson(obj) {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const frame = new Uint8Array(body.length + 1);
  frame[0] = FS_OP_JSON;
  frame.set(body, 1);
  return frame;
}

// Write one JSON request, await its reply. Holds no lock — callers own it.
function sendAndWait(fs, req, { expectFile = false, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.opChar) { reject(new Error("fs: not connected")); return; }
    const timer = setTimeout(() => {
      fs.pending = null;
      reject(new Error(`fs ${req.op} timed out`));
    }, timeoutMs);
    fs.pending = { resolve, reject, timer, expectFile, header: null };
    fs.opChar.writeValueWithResponse(frameJson(req)).catch((err) => {
      clearTimeout(timer);
      fs.pending = null;
      reject(err);
    });
  });
}

export async function listFiles(entry) {
  const fs = ensureFs(entry);
  const release = await acquire(fs);
  try { return await sendAndWait(fs, { op: "list" }, { timeoutMs: 15000 }); }
  finally { release(); }
}

export async function fsInfo(entry) {
  const { used = 0, total = 0 } = await listFiles(entry);
  return { used, total };
}

export async function statFile(entry, name) {
  const fs = ensureFs(entry);
  const release = await acquire(fs);
  try { return await sendAndWait(fs, { op: "stat", name }, { timeoutMs: 10000 }); }
  finally { release(); }
}

// Resolves { name, size, bytes: Uint8Array }.
export async function readFile(entry, name) {
  const fs = ensureFs(entry);
  const release = await acquire(fs);
  try { return await sendAndWait(fs, { op: "read", name }, { expectFile: true, timeoutMs: 30000 }); }
  finally { release(); }
}

export async function readFileText(entry, name) {
  const { bytes } = await readFile(entry, name);
  return new TextDecoder().decode(bytes);
}

// input: string or Uint8Array. Resolves { name, size } after the board's
// CRC + length verify and LittleFS commit succeed.
export async function writeFile(entry, name, input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const crc = crc32(bytes);
  const fs = ensureFs(entry);
  const release = await acquire(fs);
  try {
    await sendAndWait(fs, { op: "write", name, size: bytes.length, crc32: crc }, { timeoutMs: 15000 });
    for (let i = 0; i < bytes.length; i += WRITE_CHUNK) {
      const slice = bytes.subarray(i, Math.min(i + WRITE_CHUNK, bytes.length));
      const frame = new Uint8Array(slice.length + 1);
      frame[0] = FS_OP_WBYTES;
      frame.set(slice, 1);
      await fs.opChar.writeValueWithResponse(frame);
    }
    return await sendAndWait(fs, { op: "write-commit" }, { timeoutMs: 15000 });
  } finally {
    release();
  }
}

export async function deleteFile(entry, name) {
  const fs = ensureFs(entry);
  const release = await acquire(fs);
  try { return await sendAndWait(fs, { op: "delete", name }, { timeoutMs: 10000 }); }
  finally { release(); }
}

export async function renameFile(entry, name, to) {
  const fs = ensureFs(entry);
  const release = await acquire(fs);
  try { return await sendAndWait(fs, { op: "rename", name, to }, { timeoutMs: 10000 }); }
  finally { release(); }
}
