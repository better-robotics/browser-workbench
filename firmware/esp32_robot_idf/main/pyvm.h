#pragma once

#include <stdbool.h>

// Embedded MicroPython VM (issue #47). Runs a student Python script read from
// the LittleFS drive (/fs, fs_svc) on a dedicated task; stdout + tracebacks
// stream back over the SCRIPT_OUTPUT BLE characteristic. The Python `robot`
// module reaches hardware only through the same duration-capped C paths the
// joypad and Pip use (motors_pulse), so a script can't bypass the safety floor.
//
// Only built when CONFIG_BR_HAS_PYVM (PSRAM boards — the GC heap lives in
// SPIRAM); a no-op stub links on every other board so app_main and the GATT
// layer don't need to #ifdef around it.

// Allocate the GC heap + script buffer (PSRAM) once at boot. Safe to call on
// any board; on non-PYVM builds it does nothing and pyvm_available() is false.
void pyvm_init(void);

// True when the VM came up — gates the fw_info "python" cap.
bool pyvm_available(void);

// Start running /fs/<name>. Returns false if the VM is unavailable, a script
// is already running, or the file can't be read. Fire-and-forget; output and
// the terminal DONE/ERROR frame arrive on SCRIPT_OUTPUT.
bool pyvm_run_file(const char *name);

// Ask the running script to stop at the next VM poll point. Best-effort.
void pyvm_stop(void);

// True while a script task is active.
bool pyvm_running(void);
