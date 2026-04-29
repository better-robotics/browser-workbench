#include "pair_mailbox.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "ble_host.h"
#include "gatt_svr.h"

static const char *TAG = "mailbox";

// Ring buffer depth. 8 ads cover desktop's offer + phone's answer +
// trickle ICE on each side with margin. Each slot is a fixed 384 B
// upper bound — covers the signed-ad envelope (peer-key.js Ed25519
// pubkey + sig + JSON payload of room id / role / timestamp).
#define MAILBOX_DEPTH    8
#define MAILBOX_AD_MAX   384

typedef struct {
    uint16_t len;
    uint8_t bytes[MAILBOX_AD_MAX];
} mailbox_ad_t;

static mailbox_ad_t s_ring[MAILBOX_DEPTH];
static int s_count = 0;       // valid slots, clamped to MAILBOX_DEPTH
static int s_next  = 0;       // next slot to overwrite (oldest)
static SemaphoreHandle_t s_mutex;

void pair_mailbox_init(void) {
    s_mutex = xSemaphoreCreateMutex();
}

static void store_ad(const uint8_t *buf, size_t len) {
    if (len == 0 || len > MAILBOX_AD_MAX) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_ring[s_next].len = (uint16_t)len;
    memcpy(s_ring[s_next].bytes, buf, len);
    s_next = (s_next + 1) % MAILBOX_DEPTH;
    if (s_count < MAILBOX_DEPTH) s_count++;
    xSemaphoreGive(s_mutex);
}

void pair_mailbox_handle_write(uint16_t from_conn, const uint8_t *buf, size_t len) {
    if (len == 0 || len > MAILBOX_AD_MAX) return;
    ESP_LOGI(TAG, "ad in: %u B from conn=%u", (unsigned)len, (unsigned)from_conn);
    store_ad(buf, len);

    // Broadcast to every other connected client. Skipping the writer
    // avoids the trivial echo case; the writer already has its own ad.
    uint16_t conns[BLE_HOST_MAX_CONNS];
    size_t n = ble_host_active_conns(conns, BLE_HOST_MAX_CONNS);
    for (size_t i = 0; i < n; i++) {
        if (conns[i] == from_conn) continue;
        gatt_svr_pair_mailbox_send(conns[i], buf, len);
    }
}

void pair_mailbox_replay_to(uint16_t conn_handle) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    int sent = 0;
    // Walk oldest → newest. After s_count entries, s_next points at the
    // oldest slot (or 0 if not yet wrapped).
    int start = (s_count < MAILBOX_DEPTH) ? 0 : s_next;
    for (int i = 0; i < s_count; i++) {
        int idx = (start + i) % MAILBOX_DEPTH;
        const mailbox_ad_t *ad = &s_ring[idx];
        if (ad->len == 0) continue;
        gatt_svr_pair_mailbox_send(conn_handle, ad->bytes, ad->len);
        sent++;
    }
    xSemaphoreGive(s_mutex);
    if (sent) ESP_LOGI(TAG, "replayed %d ad(s) to conn=%u", sent, (unsigned)conn_handle);
}
