#pragma once

#include "pin_config.h"

// fw-info advertises capability surface to the dashboard. The dashboard
// renders strictly from this — no UI for hardware that didn't init,
// no missing UI for hardware that did. Built once after all caps are
// up; the camera-profile field reflects the boot-time profile (changes
// require a restart, which rebuilds fw-info on the next boot).
void fw_info_init(const pin_config_t *pins);
const char *fw_info_json(void);
