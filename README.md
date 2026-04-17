# Better Robotics

BLE-first robotics kit. Turn on a robot, open a Chrome tab, see it appear. No WiFi credentials, no network joining, no configuration files.

## Why BLE-first

Classroom and demo environments rarely give you a joinable WiFi network. The ones that do usually block multicast (so mDNS fails), require captive-portal logins (so ESP32s can't join), or have client isolation (so peers can't see each other). Every WiFi-first onboarding story collapses in a real classroom.

BLE avoids the problem entirely:
- Robot advertises the moment it boots — no network to join
- Laptop scans and sees every robot in the room
- Multi-robot discovery is just multi-scan
- Laptop's own WiFi stays connected (for internet, AI APIs)
- Zero credentials, ever

Bandwidth caps at ~1–3 Mbps, which is fine for commands, telemetry, and parameter updates. Video and other high-bandwidth work will switch to on-demand WiFi later.

## Architecture

```
┌──────────────────┐          BLE GATT           ┌──────────────────┐
│  Chrome browser  │ ◄────────────────────────► │  ESP32 firmware  │
│  (Web Bluetooth) │   commands / telemetry      │  (BLE advertise) │
└──────────────────┘                             └──────────────────┘
```

- **Firmware:** ESP32 advertises a GATT service. Each characteristic maps to a logical topic (LED state, motor command, sensor reading).
- **Dashboard:** single-page Chrome app. Uses Web Bluetooth API to scan, connect, read/write characteristics.
- **No server, no broker, no cloud.** Everything runs on the laptop.

## Scope of this repo (today)

Minimum viable path: one LED, one button.

- `firmware/esp32_ble_led/` — ESP32 firmware that advertises a GATT service with one LED-state characteristic
- `public/index.html` — Chrome page that scans for the device and toggles its LED (served by GitHub Pages via the `docs` symlink)

Once this loop works end-to-end on real hardware, scope expands to motors, sensors, and multi-robot.

## Quickstart

### 1. Install host dependencies (once per machine)
```bash
make setup
```

### 2. Flash the firmware
Plug an ESP32 in over USB:
```bash
make flash
```

### 3. Open the dashboard
```bash
make preview
```
Chrome opens at `http://localhost:8080`. Click **Scan**, pick your ESP32, toggle the LED.

## Browser support

Web Bluetooth works in Chrome, Edge, and Opera (desktop + Android). It does **not** work in Safari on iOS or macOS, and it is behind a flag in Firefox. This is a deliberate constraint — the laptop is the central brain.

## Status

Proof-of-concept. Expect it to break. The point today is to prove the primitives (BLE GATT from ESP32 ↔ Web Bluetooth from Chrome) work on the target hardware before committing to this architecture at scale.

## License

TBD.
