#!/usr/bin/env python3
"""Better Robotics — robot firmware for Raspberry Pi.

Mirrors firmware/esp32_robot/esp32_robot.ino: advertises a single BLE
service; each capability (LED, motors, sensors, ...) is a characteristic
within that service. The dashboard connects to Pi and ESP32 robots
identically.

Run:
    pip install -r requirements.txt
    python3 pi_robot.py

Note: BLE peripheral mode on Linux usually requires bluetoothd and may
need elevated privileges. See README.md.
"""

import asyncio
import logging
import socket

from bless import (
    BlessServer,
    BlessGATTCharacteristic,
    GATTCharacteristicProperties,
    GATTAttributePermissions,
)
from gpiozero import LED

# UUIDs — must match firmware/esp32_robot/esp32_robot.ino exactly.
SERVICE_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d91"
LED_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d92"

LED_PIN = 17  # BCM pin — change to match your wiring.

logging.basicConfig(format="%(asctime)s %(message)s", level=logging.INFO)
log = logging.getLogger("pi_robot")

led = LED(LED_PIN)
_led_state = 0
_server: BlessServer | None = None


def device_name() -> str:
    """BetterRobot-XXXX with a stable per-chip suffix, matching ESP32 naming."""
    suffix = None
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("Serial"):
                    suffix = line.split(":")[1].strip()[-4:].upper()
                    break
    except OSError:
        pass
    if not suffix:
        suffix = socket.gethostname()[-4:].upper().ljust(4, "0")
    return f"BetterRobot-{suffix}"


def on_read(characteristic: BlessGATTCharacteristic, **_) -> bytearray:
    if characteristic.uuid.lower() == LED_CHAR_UUID:
        return bytearray([_led_state])
    return characteristic.value


def on_write(characteristic: BlessGATTCharacteristic, value: bytearray, **_) -> None:
    global _led_state
    if characteristic.uuid.lower() != LED_CHAR_UUID or len(value) == 0:
        return
    _led_state = 1 if value[0] else 0
    led.on() if _led_state else led.off()
    characteristic.value = bytearray([_led_state])
    if _server is not None:
        _server.update_value(SERVICE_UUID, LED_CHAR_UUID)
    log.info("LED → %s", "on" if _led_state else "off")


async def main() -> None:
    global _server
    name = device_name()
    log.info("Starting %s", name)

    _server = BlessServer(name=name)
    _server.read_request_func = on_read
    _server.write_request_func = on_write

    await _server.add_new_service(SERVICE_UUID)
    await _server.add_new_characteristic(
        SERVICE_UUID,
        LED_CHAR_UUID,
        GATTCharacteristicProperties.read
        | GATTCharacteristicProperties.write
        | GATTCharacteristicProperties.notify,
        bytearray([_led_state]),
        GATTAttributePermissions.readable | GATTAttributePermissions.writeable,
    )

    await _server.start()
    log.info("Advertising on service %s", SERVICE_UUID)
    log.info("Ctrl+C to stop.")
    try:
        await asyncio.Event().wait()
    finally:
        await _server.stop()


if __name__ == "__main__":
    asyncio.run(main())
