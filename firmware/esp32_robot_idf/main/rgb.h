#pragma once

#include <stdbool.h>
#include <stdint.h>

// Common-cathode RGB LED triple driven via 3 PWM channels (one per
// color, 0..255 duty). Cap is enabled when ALL three pins are wired and
// the chip has free LEDC channels — always on classic ESP32 (RGB sits in
// the otherwise-unused HS channel bank), and on C3 only when motors are
// in PWM-on-enable mode (otherwise the motor IN-pin PWM occupies channels
// 2/3 that RGB needs). See rgb.c for the per-chip channel/timer layout.
//
// Yahboom BST-03 wiring: R/G/B → MCU GPIOs, GND → MCU GND. On-board
// resistors limit current; drive the LEDs directly from the GPIOs.
void rgb_init(int pin_r, int pin_g, int pin_b);
void rgb_apply(uint8_t r, uint8_t g, uint8_t b);
void rgb_get(uint8_t *r, uint8_t *g, uint8_t *b);
bool rgb_enabled(void);
