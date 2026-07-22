# Component sources — keep flat for now; promote subsystems to subdirs as
# they grow past ~3 files (mirrors the docs/ subsystem-promotion rule).
#
# uuids.h is generated from protocol/uuids.json by tools/gen-uuids.py.
# Firmware version comes from esp_app_get_description()->version, which
# IDF derives from `git describe --always` at build time.

# Camera and snapshot are gated on the active board:
#   - esp32-camera component is conditionally required on BR_HAS_CAMERA.
#     It doesn't compile for esp32c3 (no DVP peripheral); leaving the dep
#     in for non-camera builds fails component resolution.
#   - camera.c / snapshot.c / http_stream.c have #else stubs that take
#     over when BR_HAS_CAMERA=n, so they stay in SRCS unconditionally.

set(BR_SRCS
    "app_main.c"
    "wifi_sta.c"
    "ble_host.c"
    "gatt_svr.c"
    "pin_config.c"
    "led.c"
    "flash.c"
    "fs_svc.c"
    "motors.c"
    "encoders.c"
    "servo.c"
    "rgb.c"
    "ws2812.c"
    "ota.c"
    "camera.c"
    "snapshot.c"
    "restart_util.c"
    "fw_info.c"
    "telemetry.c"
    "http_stream.c"
)

set(BR_REQS
    # Connectivity
    nvs_flash
    esp_wifi
    esp_event
    esp_netif
    # BLE — NimBLE matches the Arduino-side stack
    bt
    # OTA
    app_update
    esp_https_ota
    # HTTP MJPEG streamer (port 81/stream) — the only camera video transport
    esp_http_server
    # Capabilities
    driver
    esp_timer
    # JSON parsing (cJSON via ESP-IDF's json component)
    json
    # On-robot file service — LittleFS over the `storage` partition (fs_svc.c).
    # Managed component joltwallet/littlefs registers as `littlefs`.
    littlefs
)

if(CONFIG_BR_HAS_CAMERA)
    list(APPEND BR_REQS esp32-camera)
endif()

# WS2812 driver (ws2812.c) needs led_strip only where an onboard one exists;
# the component is esp32s3-only in idf_component.yml, so this REQUIRES line
# is gated to the same boards to keep resolution clean on the others.
if(CONFIG_BR_HAS_WS2812)
    list(APPEND BR_REQS led_strip)
endif()

idf_component_register(
    SRCS ${BR_SRCS}
    INCLUDE_DIRS "."
    PRIV_REQUIRES ${BR_REQS}
)
