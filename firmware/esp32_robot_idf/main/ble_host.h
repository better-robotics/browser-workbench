#pragma once

#include <stdint.h>

#include "host/ble_hs.h"

// Bring up NimBLE host stack and start advertising under `name` with the
// project's SERVICE_UUID. Restarting advertising on disconnect is handled
// internally so the device is rediscoverable after each desktop session.
void ble_host_init(const char *name);

// Active connection handle, or BLE_HS_CONN_HANDLE_NONE if no central is
// connected. Used by snapshot to send custom-payload notifies via
// ble_gatts_notify_custom (which requires a conn handle).
uint16_t ble_host_active_conn(void);
