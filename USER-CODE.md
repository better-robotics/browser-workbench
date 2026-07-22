# User code

Scripts are **Python that runs on the robot**. You write them in the IDE
(Scripts), ship them to the robot over BLE, and the robot's embedded
MicroPython VM runs them — no dashboard tether once they're running, no
compile step.

## The `robot` API

```python
# Runs on the robot's VM. print() streams back to the editor's output panel.
print("hello from the robot")

# robot.move(left, right, duration_ms): pulse-bounded motion. Signed
# magnitudes; move() drives for duration_ms then returns. The firmware caps
# the duration, so a script can't drive past the pulse window.
robot.move(60, 60, 400)     # forward
robot.sleep(300)            # pause, no motion
robot.move(-60, -60, 400)   # back

robot.led(True)             # LED on
```

In scope inside a script: the injected `robot` object (`move`, `led`,
`sleep`) and `print()`, plus MicroPython's built-in language. The IDE offers
completions for the `robot` API (`robot.` → move / led / sleep) and ships the
templates as "New from template" seed files. The surface is deliberately
small — it grows as the firmware's `robot` module does (pyvm.c).

## Where files live

Files show side by side in the IDE's file tree:

- **On the robot** — a connected robot with the file service lists its files
  under "On <robot>". They're stored in a LittleFS partition in the robot's
  flash, so they survive a reboot and roam with the hardware. Save streams the
  file over BLE with a length + CRC32 check; a file only lands if it arrives
  intact. Multi-robot is ship-and-run-to-N: save the same file to each robot
  and run it.
- **Local drafts** — files kept in this browser under "Local". The offline
  path: author with no robot connected, run once one's paired.

Per-robot limits: 32 KB per file, 64 files. Over a limit, the save surfaces a
plain-language error, not a silent failure.

## Safety floor

The `robot` API is the *only* way a script reaches hardware, and every motion
call goes through the same `motors_pulse` path the joypad and Pip use — which
clamps the pulse to the firmware's duration cap (`LLM_MAX_DURATION_MS`). A
script inherits that floor and cannot exceed it; a runaway or malformed script
still auto-stops at the pulse window. The watchdog and ultrasonic
forward-clip apply regardless of who issued the write. This is why the VM sits
*on top of* the C firmware rather than replacing it — the intelligent layer
can't bypass the safety layer.

## Which robots can run Python

On-robot Python needs the MicroPython VM, which needs PSRAM for its heap — so
it's an ESP32-S3 (`s3_cam`) capability today. A robot advertises the `python`
capability when its VM is up; the IDE's Run targets those robots. Boards
without it (classic ESP32-CAM, C3) still author and store files, they just
can't run them on-device.
