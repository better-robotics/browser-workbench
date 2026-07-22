#include "ws2812.h"

#include "sdkconfig.h"

#if CONFIG_BR_HAS_WS2812

#include "esp_log.h"
#include "led_strip.h"

#include "pin_config.h"

static const char *TAG = "ws2812";

static led_strip_handle_t s_strip = NULL;
static uint8_t s_rgb[3] = { 0, 0, 0 };

void ws2812_init(int pin) {
    if (!pin_valid(pin)) {
        ESP_LOGI(TAG, "no ws2812 pin, cap disabled");
        return;
    }
    led_strip_config_t strip_cfg = {
        .strip_gpio_num = pin,
        .max_leds = 1,
        // WS2812 wants GRB order; the driver reorders so set_pixel takes RGB.
        .led_pixel_format = LED_PIXEL_FORMAT_GRB,
        .led_model = LED_MODEL_WS2812,
        .flags = { .invert_out = false },
    };
    led_strip_rmt_config_t rmt_cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000,  // 10 MHz — WS2812 bit timing
        .flags = { .with_dma = false },      // one pixel; DMA is overkill
    };
    esp_err_t err = led_strip_new_rmt_device(&strip_cfg, &rmt_cfg, &s_strip);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "led_strip init failed: %s", esp_err_to_name(err));
        s_strip = NULL;
        return;
    }
    led_strip_clear(s_strip);
    ESP_LOGI(TAG, "ready on GPIO %d", pin);
}

void ws2812_apply(uint8_t r, uint8_t g, uint8_t b) {
    s_rgb[0] = r; s_rgb[1] = g; s_rgb[2] = b;
    if (!s_strip) return;
    led_strip_set_pixel(s_strip, 0, r, g, b);
    led_strip_refresh(s_strip);
}

void ws2812_get(uint8_t *r, uint8_t *g, uint8_t *b) {
    *r = s_rgb[0]; *g = s_rgb[1]; *b = s_rgb[2];
}

bool ws2812_enabled(void) { return s_strip != NULL; }

#else  // no onboard WS2812 — stubs so gatt_svr / fw_info callers stay clean.

void ws2812_init(int pin) { (void)pin; }
void ws2812_apply(uint8_t r, uint8_t g, uint8_t b) { (void)r; (void)g; (void)b; }
void ws2812_get(uint8_t *r, uint8_t *g, uint8_t *b) { *r = 0; *g = 0; *b = 0; }
bool ws2812_enabled(void) { return false; }

#endif  // CONFIG_BR_HAS_WS2812
