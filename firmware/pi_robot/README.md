# pi_robot

Python robot firmware for the Raspberry Pi. Mirrors `firmware/esp32_robot/` — same BLE service, same characteristic UUIDs, same dashboard experience.

## Setup

```bash
cd firmware/pi_robot
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Make sure Bluetooth is enabled:
```bash
sudo systemctl status bluetooth
```

## Run

```bash
python3 pi_robot.py
```

The robot will advertise as `BetterRobot-XXXX` (suffix derived from the Pi's chip serial). Scan for it from the dashboard at [neevs.io/better-robotics](https://neevs.io/better-robotics/).

## LED wiring

Default GPIO pin is `17` (BCM). To change, edit the `LED_PIN` constant at the top of `pi_robot.py`. For a quick test without an external LED, pick any pin and probe it with a multimeter — or swap to GPIO 47 (the green ACT LED on Pi 4) if you'd rather not wire anything.

## Permissions

BLE peripheral mode on Linux talks to `bluetoothd` over D-Bus. On most Pi OS installs this works without `sudo`, but if you see `org.bluez.Error.NotPermitted` or `Rejected send message`, either run with `sudo` or grant the user access:

```bash
sudo usermod -aG bluetooth $USER
# then log out and back in
```

## Auto-start on boot (optional)

Drop this into `/etc/systemd/system/pi-robot.service`:

```ini
[Unit]
Description=Better Robotics — Pi robot firmware
After=bluetooth.service
Requires=bluetooth.service

[Service]
ExecStart=/home/pi/better-robotics/firmware/pi_robot/.venv/bin/python /home/pi/better-robotics/firmware/pi_robot/pi_robot.py
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable --now pi-robot
```

## Adding capabilities

Same pattern as the ESP32 variant: add new characteristics inside the existing service. Motors, sensors, and encoders become additional characteristics that the dashboard discovers on connect. The service UUID stays the same, so a Pi robot and an ESP32 robot look identical to users.
