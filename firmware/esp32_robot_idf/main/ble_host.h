#pragma once

#include <stdint.h>

#include "host/ble_hs.h"

// Bring up NimBLE host stack and start advertising under `name` with the
// project's SERVICE_UUID. Restarting advertising on disconnect is handled
// internally so the device is rediscoverable after each desktop session.
void ble_host_init(const char *name);

// Active connection handle of the most-recent peer, or
// BLE_HS_CONN_HANDLE_NONE if no central is connected.
uint16_t ble_host_active_conn(void);

// Max simultaneous centrals tracked. Match CONFIG_BT_NIMBLE_MAX_CONNECTIONS
// in sdkconfig.defaults — the chip can advertise + accept overlap during
// dashboard reconnects.
#define BLE_HOST_MAX_CONNS 2
