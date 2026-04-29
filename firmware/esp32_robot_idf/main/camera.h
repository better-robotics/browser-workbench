#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Three discrete operating points the operator can pick. Persisted in
// NVS namespace "cam" / key "profile" — applied at camera_init time, no
// hot-swap (changing it via BLE schedules a restart in 2.C.5).
typedef enum {
    CAM_PROFILE_COMPACT  = 0,   // QVGA, q=15 — daily-use default
    CAM_PROFILE_STANDARD = 1,   // VGA,  q=12
    CAM_PROFILE_FULL     = 2,   // SVGA, q=10
} camera_profile_t;

const char *camera_profile_name(camera_profile_t p);
camera_profile_t camera_profile_from_name(const char *name);

// Reads profile from NVS, calls esp_camera_init with the AI-Thinker pin
// map, applies sensor tuning. Returns false if init fails — caller checks
// camera_init_error() for the esp_err_t code.
bool camera_init(void);
bool camera_ready(void);
int camera_init_error(void);
camera_profile_t camera_get_profile(void);

// Handle a write to the BLE camera-profile char. JSON payload:
//   {"profile":"compact|standard|full"}.
// Persists to NVS and schedules a restart so initCamera reads the new
// value at boot — no hot-swap.
void camera_handle_profile_write(const uint8_t *json, size_t len);
