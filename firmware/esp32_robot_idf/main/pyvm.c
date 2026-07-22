#include "pyvm.h"

#include "sdkconfig.h"

#if CONFIG_BR_HAS_PYVM

#include <stdio.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "py/builtin.h"
#include "py/compile.h"
#include "py/gc.h"
#include "py/mphal.h"
#include "py/runtime.h"
#include "py/stackctrl.h"
#include "port/micropython_embed.h"

#include "gatt_svr.h"
#include "led.h"
#include "motors.h"
#include "protocol_constants.h"

static const char *TAG = "pyvm";

// GC heap in PSRAM — a classroom script (a few KB of source + modest runtime
// objects) fits comfortably; the internal DRAM stays reserved for the radios.
#define PYVM_HEAP_SIZE   (128 * 1024)
// Script source buffer — the fs cap enforces the 32 KB file ceiling.
#define PYVM_SCRIPT_MAX  (32 * 1024)
#define PYVM_TASK_STACK  (20 * 1024)

static uint8_t *s_heap = NULL;      // PSRAM GC heap
static char    *s_script = NULL;    // PSRAM source buffer (null-terminated)
static TaskHandle_t s_task = NULL;
static volatile bool s_stop = false;

// ---- output stream -------------------------------------------------------

// Accumulate stdout and flush on newline / when full, so we send whole lines
// over BLE rather than a notify per character. SCRIPT_OUT_TEXT frames.
#define OUT_BUF 180
static uint8_t s_out[1 + OUT_BUF];
static size_t  s_out_len = 0;

static void out_flush(void) {
    if (s_out_len == 0) return;
    s_out[0] = SCRIPT_OUT_TEXT;
    gatt_svr_script_send(s_out, 1 + s_out_len);
    s_out_len = 0;
}

static void out_write(const char *str, size_t len) {
    for (size_t i = 0; i < len; i++) {
        s_out[1 + s_out_len++] = (uint8_t)str[i];
        if (str[i] == '\n' || s_out_len == OUT_BUF) out_flush();
    }
}

// MicroPython's platform print routes here (generated port/mphalport.c is
// excluded from the build — see the component CMakeLists). Only _cooked is
// needed; it's what mp_plat_print uses, as in the stock embed port.
void mp_hal_stdout_tx_strn_cooked(const char *str, size_t len) { out_write(str, len); }

// ---- robot module (the safety-bridged API) -------------------------------

// robot.move(left, right, duration_ms) — pulse-bounded motion. Goes straight
// through motors_pulse, which clamps duration to LLM_MAX_DURATION_MS: a script
// gets the same firmware floor as the joypad and Pip, and cannot exceed it.
static mp_obj_t robot_move(mp_obj_t left_o, mp_obj_t right_o, mp_obj_t dur_o) {
    int left = mp_obj_get_int(left_o);
    int right = mp_obj_get_int(right_o);
    int dur = mp_obj_get_int(dur_o);
    motors_pulse((int8_t)left, (int8_t)right, (uint16_t)(dur < 0 ? 0 : dur));
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_3(robot_move_obj, robot_move);

// robot.led(on)
static mp_obj_t robot_led(mp_obj_t on_o) {
    led_apply(mp_obj_is_true(on_o));
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_1(robot_led_obj, robot_led);

// Inject a `robot` module into the global namespace (runtime qstrs, so the
// generated qstr tables don't need to carry these names). Wrapped in its own
// nlr frame; a raise here (OOM) aborts injection without crashing the task.
static void inject_robot(void) {
    nlr_buf_t nlr;
    if (nlr_push(&nlr) == 0) {
        mp_obj_t mod = mp_obj_new_module(qstr_from_str("robot"));
        mp_obj_t g = MP_OBJ_FROM_PTR(mp_obj_module_get_globals(mod));
        mp_obj_dict_store(g, MP_OBJ_NEW_QSTR(qstr_from_str("move")), MP_OBJ_FROM_PTR(&robot_move_obj));
        mp_obj_dict_store(g, MP_OBJ_NEW_QSTR(qstr_from_str("led")),  MP_OBJ_FROM_PTR(&robot_led_obj));
        mp_store_global(qstr_from_str("robot"), mod);
        nlr_pop();
    }
}

// ---- run task ------------------------------------------------------------

static void run_task(void *arg) {
    volatile int stack_top;
    mp_embed_init(s_heap, PYVM_HEAP_SIZE, (void *)&stack_top);
    inject_robot();
    // mp_embed_exec_str compiles + runs and prints any uncaught exception
    // through the stdout hook above, so the traceback reaches the IDE.
    mp_embed_exec_str(s_script);
    mp_embed_deinit();
    out_flush();

    uint8_t done = SCRIPT_OUT_DONE;
    gatt_svr_script_send(&done, 1);
    s_task = NULL;
    vTaskDelete(NULL);
}

bool pyvm_run_file(const char *name) {
    if (!s_heap || !s_script) return false;
    if (s_task) { ESP_LOGW(TAG, "busy — a script is already running"); return false; }
    if (!name || !name[0]) return false;

    char path[64];
    snprintf(path, sizeof(path), "/fs/%s", name);
    FILE *f = fopen(path, "rb");
    if (!f) { ESP_LOGW(TAG, "cannot open %s", path); return false; }
    size_t n = fread(s_script, 1, PYVM_SCRIPT_MAX, f);
    fclose(f);
    s_script[n] = '\0';

    s_stop = false;
    // Pinned to core 1 so the NimBLE host on core 0 keeps servicing BLE while
    // the VM runs. Big stack — MicroPython's compiler + call frames are deep.
    BaseType_t rc = xTaskCreatePinnedToCore(run_task, "pyvm", PYVM_TASK_STACK, NULL, 4, &s_task, 1);
    if (rc != pdPASS) { ESP_LOGE(TAG, "task create rc=%d", (int)rc); s_task = NULL; return false; }
    return true;
}

void pyvm_stop(void) {
    // Best-effort cooperative stop. Cleanly interrupting a running VM needs a
    // scheduler poll hook (follow-up once the VM is validated on hardware);
    // the pulse-duration cap already bounds any motion a runaway script issues.
    s_stop = true;
}

bool pyvm_running(void) { return s_task != NULL; }

bool pyvm_available(void) { return s_heap != NULL && s_script != NULL; }

void pyvm_init(void) {
    s_heap = heap_caps_malloc(PYVM_HEAP_SIZE, MALLOC_CAP_SPIRAM);
    s_script = heap_caps_malloc(PYVM_SCRIPT_MAX + 1, MALLOC_CAP_SPIRAM);
    if (!s_heap || !s_script) {
        ESP_LOGE(TAG, "no PSRAM for VM heap/script — Python unavailable");
        if (s_heap) { heap_caps_free(s_heap); s_heap = NULL; }
        if (s_script) { heap_caps_free(s_script); s_script = NULL; }
        return;
    }
    ESP_LOGI(TAG, "MicroPython VM ready — %d KB heap in PSRAM", PYVM_HEAP_SIZE / 1024);
}

#else  // CONFIG_BR_HAS_PYVM

// No-VM boards: link the same symbols as no-ops so app_main / gatt don't #ifdef.
void pyvm_init(void) {}
bool pyvm_available(void) { return false; }
bool pyvm_run_file(const char *name) { (void)name; return false; }
void pyvm_stop(void) {}
bool pyvm_running(void) { return false; }

#endif  // CONFIG_BR_HAS_PYVM
