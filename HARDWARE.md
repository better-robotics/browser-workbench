# Hardware guide

## Current: ESP32-CAM-MB

The kit ships with the **ESP32-CAM-MB**: AI Thinker ESP32-CAM module mounted on a programmer carrier with a USB micro-B port. Plug in, flash from the dashboard, done. The published binaries in `public/firmware/bins/` target this board; nothing else has prebuilt artifacts yet.

**Bare ESP32-CAM ≠ ESP32-CAM-MB.** Two SKUs ship under the same "ESP32-CAM" name. The bare module has no USB at all; flashing requires an external FTDI/CP2102 adapter wired to U0R/U0T/GND with IO0 grounded for boot. The MB carrier *is* the USB-to-serial bridge. Look for a separate small PCB with a USB micro-B port: that's the MB. Buy the kit version unless you specifically want the wiring exercise.

USB-UART chip on the MB carrier is CP2102 on most units, FT232R on some (silkscreened). macOS has the FTDI driver built in; CP2102 needs a [one-time kernel extension install from Silicon Labs](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers).

Buy: AI Thinker ESP32-CAM-MB sells widely on Amazon and AliExpress. Gotcha: confirm the listing includes the MB programmer carrier, not just the bare camera module.

### Camera on the CAM-MB

The 24-pin socket on the AI-Thinker board accepts OV2640, OV3660, and OV5640 modules — Espressif's `esp_camera` driver auto-detects the sensor. Firmware uses the stock AI-Thinker pin map (XCLK 0, SIOD 26, SIOC 27, data 5/18/19/21/36/39/34/35, VSYNC 25, HREF 23, PCLK 22, PWDN 32). VGA (640×480) JPEG, framebuffers in PSRAM, ~15 fps. Once WiFi is joined the firmware starts an MJPEG HTTP server on `:81/stream`, broadcasts its LAN IP on `wifi-status`, and advertises a `camera` capability of type `mjpeg-stream` in fw-info. The dashboard opens the stream as a plain `<img>` once both pieces are present. Dashboard browser must share a network with the robot — this is the WiFi data plane, not BLE.

## Forward path: ESP32-C6 and ESP32-S3

Source compiles for both. **CI doesn't publish prebuilt binaries yet.** Flashing means cloning the repo and running `make flash` locally. Once a board is in hand to validate, CI can add targets and the dashboard's Flash button will route via `manifest.json`.

**ESP32-C6** is the natural BLE-first match: native USB CDC (no drivers), Bluetooth 5.3 LE, materially better RAM headroom than S3 when TLS shares memory with BLE during OTA, matches "BLE is the control plane" without dragging WiFi-radio cost. DevKitC-1 or any WROOM-based C6 board.

**ESP32-S3** is the path if you need dual-core or a camera. ESP32-S3-CAM, Freenove ESP32-S3-WROOM, or any DevKitC-S3. Native USB CDC, larger BLE/WiFi memory footprint than C6.

Buy in US: [Adafruit](https://www.adafruit.com/?q=ESP32-C6) (C6, S3), DigiKey, Mouser. Espressif's official store ships globally. Freenove kit ships from Amazon.

## Raspberry Pi

Tested on **Pi 4 Model B**. Bluetooth radio built in. Pi OS Bookworm (Python 3.11) or Trixie (Python 3.13) — the dashboard's Customize-card flow stages wheels for both.

Buy in US: [Adafruit](https://www.adafruit.com/?q=raspberry+pi+4), CanaKit, PiShop.us. Outside US: [official reseller list](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/).

### Recovery plane (USB-C)

The Pi boots with a **composite USB gadget** (ECM ethernet + ACM serial) under `usb-gadget.service`, independent of the main firmware service. Plug USB-C from the Pi into your laptop:

- **ECM ethernet** — Pi appears at `10.55.0.1`; `ssh pi@10.55.0.1` works with the sudo password you set in Customize card.
- **ACM serial** — Pi appears as `/dev/cu.usbmodem*`; the dashboard's ⋯ → **Recovery console** menu item opens a full xterm.js terminal over this. Works even when BLE and WiFi are both dead, because the gadget is a kernel-level service that runs before `pi-robot` and doesn't depend on it.

Requires a USB-C **data** cable (not charge-only) — Anker or Cable Matters USB-C-to-USB-C marked "data" or "sync" works. The gotcha is power-only variants that look identical and ship in the box with most chargers. The Pi 4's USB-C port is the only gadget-capable port; USB-A ports on the top edge are hosts and won't work for this.

## Board-specific knobs

Two variables need to match your ESP32 board:

- **`FQBN`** in `Makefile` — `esp32:esp32:esp32cam:PartitionScheme=min_spiffs` for CAM-MB; for S3, something like `esp32:esp32:esp32s3:PartitionScheme=min_spiffs,USBMode=default,CDCOnBoot=cdc`; for C6, `esp32:esp32:esp32c6:PartitionScheme=min_spiffs,CDCOnBoot=cdc` (run `arduino-cli board listall` for exact identifiers on your core version).
- **`LED_PIN`** in `firmware/esp32_robot/esp32_robot.ino` — GPIO 33 active-low on CAM-MB. S3 and C6 boards vary; many use a WS2812 neopixel (GPIO 48 on DevKitC-S3, GPIO 8 on DevKitC-C6) which needs a different driver entirely.

`min_spiffs` is load-bearing across both: its dual 1.9 MB app partitions are what OTA needs to stage an update without wiping the running image.

After changing either, push to `main` — CI rebuilds and publishes the new binary automatically. Run `make publish-firmware` locally only to preview before pushing.
