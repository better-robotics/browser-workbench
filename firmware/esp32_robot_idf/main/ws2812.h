#pragma once

#include <stdbool.h>
#include <stdint.h>

// Single-wire addressable RGB (WS2812/NeoPixel), e.g. the Freenove
// ESP32-S3-WROOM CAM's onboard LED on GPIO48. Presents the same R/G/B
// surface as the 3-pin rgb.c driver, so the dashboard's "rgb" color-picker
// cap drives it unchanged — gatt_svr's rgb write path fans out to both.
// Compiles to no-ops when CONFIG_BR_HAS_WS2812 is unset.

void ws2812_init(int pin);
void ws2812_apply(uint8_t r, uint8_t g, uint8_t b);
void ws2812_get(uint8_t *r, uint8_t *g, uint8_t *b);
bool ws2812_enabled(void);
