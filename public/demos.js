// Scripted demo routines — short, reliable, demo-friendly choreographies
// that always look the same. The "always-works safety net" complement
// to LLM-driven exploration: when you have 30 seconds in front of
// someone, you reach for these.
//
// Each demo's `run(ctx)` is async and orchestrates calls to ctx.exec()
// (the executor with pill rendering) and ctx.sleep(). Demos can issue
// `move_motor`, `speak`, `start_robot_camera`, `start_robot_watcher`,
// `get_robot_detections` — same primitives the LLM uses. So a demo
// step renders in the chat the same way an LLM-issued tool call does.
//
// Pattern reference: Boston Dynamics Spot Choreographer (music-synced
// step sequences), DJI Robomaster S1 Lab Mode (named routines), Petoi
// Bittle bundled dances. The shared trick is keeping each step ≤ 1s so
// dead-reckoning drift doesn't accumulate visibly between demos.

const SPEED = 40;        // saturate; firmware caps to ±40 anyway

// pulse-and-settle: move_motor is bounded; we wait the pulse duration
// plus a small settle window before the next call so we don't queue
// pulses on top of each other (firmware would cancel-and-replace and
// the motion would jerk).
async function pulse(ctx, l, r, ms) {
  await ctx.exec("move_motor", { id: ctx.id, l, r, duration_ms: ms });
  await ctx.sleep(ms + 30);
}

// 1 — Figure-8. Two arcs in opposite curves, ~5s total. Classic
//     differential-drive showpiece; the smoothness reads as intent.
async function figure8(ctx) {
  for (let i = 0; i < 4; i++) await pulse(ctx,  SPEED,         SPEED * 0.4, 700);
  for (let i = 0; i < 4; i++) await pulse(ctx,  SPEED * 0.4,   SPEED,       700);
}

// 2 — Zigzag forward sweep. Reads as "searching"; pairs well with a
//     spoken status line midway through.
async function zigzag(ctx) {
  for (let i = 0; i < 3; i++) {
    await pulse(ctx,  SPEED,        SPEED * 0.35, 550);
    await pulse(ctx,  SPEED * 0.35, SPEED,        550);
  }
}

// 3 — Dance. Beat sequence with vocal punctuation. Spot/Petoi pattern:
//     music covers small motion variance, the "ta-da!" is the reveal.
async function dance(ctx) {
  await ctx.exec("speak", { text: "Watch this." });
  await ctx.sleep(700);
  const beats = [
    [-SPEED,  SPEED, 350],
    [ SPEED, -SPEED, 350],
    [ SPEED,  SPEED, 250],
    [-SPEED, -SPEED, 250],
    [-SPEED,  SPEED, 350],
    [ SPEED, -SPEED, 350],
    [ SPEED,  SPEED, 500],
  ];
  for (const [l, r, ms] of beats) await pulse(ctx, l, r, ms);
  await ctx.exec("speak", { text: "Ta-da!" });
}

// 4 — Patrol. Forward sweep + alternating spin "look around" between
//     sweeps. Reads as "alive" because the robot keeps checking.
async function patrol(ctx) {
  for (let i = 0; i < 3; i++) {
    await pulse(ctx,  SPEED,  SPEED, 700);
    await ctx.sleep(250);
    await pulse(ctx, -SPEED,  SPEED, 500);
    await ctx.sleep(150);
    await pulse(ctx,  SPEED, -SPEED, 500);
    await ctx.sleep(150);
  }
  await ctx.exec("speak", { text: "Patrol complete." });
}

// 5 — React. Camera + fire-once watcher on `person`. The Cozmo move:
//     reactive personality lands harder than raw motion. Hands off to
//     the watcher's halt_and_speak action so the robot reacts even if
//     the user closes the dashboard.
async function react(ctx) {
  await ctx.exec("start_robot_camera", { id: ctx.id });
  await ctx.exec("speak", { text: "Watching for a person." });
  await ctx.exec("start_robot_watcher", {
    id: ctx.id,
    classes: ["person"],
    action: "halt_and_speak",
    speak_text: "Hi there!",
  });
}

// 6 — Follow. Closed-loop detection-driven approach. The killer one —
//     it's the only routine a competitor can't fake with timed pulses
//     because the LLM-loop is the control system. Open the camera, then
//     query → decide → pulse → repeat for N steps. Bbox cx convention
//     from get_robot_detections: cx<0.45 = left of center, cx>0.55 =
//     right; otherwise drive forward.
async function follow(ctx, target = "person") {
  await ctx.exec("start_robot_camera", { id: ctx.id });
  await ctx.exec("speak", { text: `Following ${target}.` });
  const STEPS = 8;
  for (let i = 0; i < STEPS; i++) {
    if (ctx.shouldAbort?.()) return;
    const r = await ctx.exec("get_robot_detections", { id: ctx.id, queries: [target] });
    // Detection response shape varies a bit by camera; normalize.
    const hits = r?.detections || r?.results || (Array.isArray(r) ? r : []);
    const det = hits[0];
    if (!det) {
      // Lost target — small scan-spin and try again.
      await pulse(ctx, -SPEED, SPEED, 250);
      continue;
    }
    const cx = det.bbox?.cx ?? 0.5;
    if      (cx < 0.45) await pulse(ctx, -SPEED,  SPEED, 200);  // turn left
    else if (cx > 0.55) await pulse(ctx,  SPEED, -SPEED, 200);  // turn right
    else                await pulse(ctx,  SPEED,  SPEED, 400);  // drive forward
  }
}

const DEMOS = {
  figure8: { run: figure8, label: "figure-8" },
  zigzag:  { run: zigzag,  label: "zigzag"  },
  dance:   { run: dance,   label: "dance"   },
  patrol:  { run: patrol,  label: "patrol"  },
  react:   { run: react,   label: "react"   },
  follow:  { run: follow,  label: "follow"  },
};

export const DEMO_NAMES = Object.keys(DEMOS);

// Match `demo <name>` or `/demo <name>`. Aliases cover the variations
// Web Speech produces — "figure eight" / "figure 8" / "figure-eight",
// "zig zag" / "zigzag", etc. Dictated demo invocations should "just
// work" without the user having to spell things exactly.
const ALIASES = {
  figure8: /(?:figure[\s-]*(?:eight|8))/i,
  zigzag:  /(?:zig[\s-]*zag)/i,
  dance:   /dance/i,
  patrol:  /patrol/i,
  react:   /react/i,
  follow:  /follow/i,
};
const RX_PREFIX = /^\/?demo\s+(.+)$/i;

export function tryMatchDemo(text) {
  const m = RX_PREFIX.exec((text || "").trim());
  if (!m) return null;
  const tail = m[1];
  for (const [name, rx] of Object.entries(ALIASES)) {
    if (rx.test(tail)) {
      // Optional trailing word for follow's target ("demo follow cup").
      const argMatch = name === "follow"
        ? tail.replace(rx, "").trim().split(/\s+/)[0]
        : null;
      const d = DEMOS[name];
      return { name, label: d.label, run: (ctx) => d.run(ctx, argMatch || undefined) };
    }
  }
  return null;
}
