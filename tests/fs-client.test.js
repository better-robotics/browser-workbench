import { test } from "node:test";
import assert from "node:assert/strict";

import { crc32 } from "../docs/fs/fs-client.js";

// The file service rejects a write whose CRC32 disagrees with the board's.
// These reference values are the standard reflected IEEE CRC-32 (== zlib /
// Python's zlib.crc32) — if this drifts, so does the hand-rolled twin in
// firmware/esp32_robot_idf/main/fs_svc.c and every write silently fails.
const enc = (s) => new TextEncoder().encode(s);

test("crc32: matches standard IEEE reference vectors", () => {
  assert.equal(crc32(enc("")), 0x00000000);
  assert.equal(crc32(enc("a")), 0xe8b7be43);
  assert.equal(crc32(enc("abc")), 0x352441c2);
  assert.equal(crc32(enc("The quick brown fox jumps over the lazy dog")), 0x414fa339);
  assert.equal(crc32(new Uint8Array([0])), 0xd202ef8d);
});

test("crc32: a real script body round-trips to an unsigned 32-bit int", () => {
  const v = crc32(enc("robot.move({left:60,right:60})"));
  assert.equal(v, 0x38e8aeb7);
  assert.ok(v >= 0 && v <= 0xffffffff);
});
