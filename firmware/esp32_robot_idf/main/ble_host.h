#pragma once

#include <stdint.h>

#include "host/ble_hs.h"

// Bring up NimBLE host stack and start advertising under `name` with the
// project's SERVICE_UUID. Restarting advertising on disconnect is handled
// internally so the device is rediscoverable after each desktop session.
void ble_host_init(const char *name);

// Active connection handle of the most-recent peer, or
// BLE_HS_CONN_HANDLE_NONE if no central is connected. Used by snapshot
// + signal char (single-peer flows). For mailbox-style broadcast,
// see ble_host_active_conns below.
uint16_t ble_host_active_conn(void);

// Phase 2.F.2: phone-pair via BLE-relay needs both phone and desktop
// concurrently connected. Fill `out` with all current conn handles
// (up to `cap`); returns the count. Tracks all subscribers so the
// pair-mailbox can broadcast to every connected client.
#define BLE_HOST_MAX_CONNS 4
size_t ble_host_active_conns(uint16_t *out, size_t cap);
