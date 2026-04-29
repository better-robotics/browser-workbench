#pragma once

// System-health telemetry — uptime, heap watermarks, reset reason, IP.
// Rebuilt every 10 s by an esp_timer; the dashboard subscribes to NOTIFY
// to track slow leaks and silent reboots.
void telemetry_init(void);
const char *telemetry_json(void);
