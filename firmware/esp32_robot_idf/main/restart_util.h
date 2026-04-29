#pragma once

#include <stdint.h>

// Defer a chip restart by `delay_ms`. Used by pin_config / ota / camera-
// profile writes — the BLE ATT response (or HTTP body) needs to land
// before the radio drops, otherwise the dashboard sees a "GATT operation
// failed" / "fetch failed" instead of the success it earned.
void schedule_restart(uint64_t delay_ms);
