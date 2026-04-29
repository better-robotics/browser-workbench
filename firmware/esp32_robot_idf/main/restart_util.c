#include "restart_util.h"

#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"

static const char *TAG = "restart";

static void fire(void *arg) {
    ESP_LOGI(TAG, "restarting");
    esp_restart();
}

void schedule_restart(uint64_t delay_ms) {
    esp_timer_create_args_t a = { .callback = fire, .name = "restart" };
    esp_timer_handle_t t;
    esp_timer_create(&a, &t);
    esp_timer_start_once(t, delay_ms * 1000);
}
