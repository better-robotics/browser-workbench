#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// On-robot file service: a flat LittleFS namespace on the `storage`
// partition (partitions.csv), exposed over BLE via the FS_OP / FS_DATA
// characteristics (gatt_svr.c). Wire protocol + op vocabulary: fs_svc.c
// header comment; the browser side is docs/fs/fs-client.js.

// Probe the `storage` partition by label and mount LittleFS on it. Boot
// probe, not assumption: a unit that OTA'd the app onto an old partition
// table (no `storage`) mounts nothing and reports the fs unavailable —
// every other capability still runs. Call once at boot, before
// fw_info_init (which gates the "fs" cap on fs_svc_available).
void fs_svc_init(void);

// True when the storage partition mounted. Gates the fw_info "fs" cap.
bool fs_svc_available(void);

// Handle one FS_OP write frame (leading opcode + payload) from the GATT
// layer. Non-blocking: JSON control ops are queued to the fs worker task,
// which streams the chunked FS_DATA reply; raw write-session bytes append
// synchronously (the client serializes a file upload behind its ack).
void fs_svc_handle_op(const uint8_t *buf, size_t len);
