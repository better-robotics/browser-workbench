// Seed files for "New from template" — Python that runs on the robot's
// MicroPython VM (issue #47), not in the browser. The on-robot surface is
// small and honest: the injected `robot` object (move / led / sleep) plus
// print(), which streams to the editor's output panel. Mirror pyvm.c's robot
// module when the firmware API grows.
export const TEMPLATES = [
  {
    id: "hello",
    name: "hello.py",
    label: "Hello — moves + print",
    body: `# Runs on the robot. print() streams back to the output panel.
# robot.move(left, right, duration_ms) drives for duration_ms then returns;
# the firmware caps the duration, so a script can't drive past the pulse window.

print("hello from the robot")

robot.move(60, 60, 400)     # forward
robot.sleep(300)
robot.move(-60, -60, 400)   # back
print("done")
`,
  },
  {
    id: "lights",
    name: "lights.py",
    label: "Lights — cycle the onboard RGB",
    body: `# Cycle the onboard RGB LED through a few colors.
# robot.rgb(r, g, b) — 0..255 per channel.
colors = [
    (255, 0, 0),    # red
    (0, 255, 0),    # green
    (0, 0, 255),    # blue
    (255, 255, 0),  # yellow
]
for i in range(2):
    for r, g, b in colors:
        robot.rgb(r, g, b)
        print("rgb", r, g, b)
        robot.sleep(300)

robot.rgb(0, 0, 0)   # off
print("done")
`,
  },
  {
    id: "square",
    name: "square.py",
    label: "Square dance — patterned drive",
    body: `# Drive a rough square. Tune the turn duration for your robot.
for side in range(4):
    print("side", side + 1, "of 4")
    robot.move(35, 35, 800)     # forward
    robot.sleep(300)
    robot.move(35, -35, 380)    # turn ~90 degrees
    robot.sleep(300)

print("done -- adjust durations if it doesn't close up")
`,
  },
  {
    id: "spin",
    name: "spin.py",
    label: "Spin — turn in place",
    body: `# Spin in place, blinking as it goes.
for i in range(6):
    robot.led(i % 2 == 0)
    robot.move(40, -40, 300)
    robot.sleep(100)

robot.led(False)
print("done")
`,
  },
];
