#include "webrtc_peer.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "peer.h"
#include "peer_connection.h"

#include "esp_camera.h"

#include "camera.h"
#include "gatt_svr.h"
#include "ota.h"
#include "turn_creds.h"

static const char *TAG = "rtc";

static PeerConnection *s_pc;

// Loop task drains events from the BLE-signaling handler and pumps
// libpeer. Single-threaded ownership of s_pc avoids a mutex around
// every state-machine tick.
typedef enum {
    EV_OFFER_BLE,
    EV_ICE,
} event_type_t;

// BLE-only: the conn handle of the central that wrote the offer. The
// answer notify routes here, not to ble_host_active_conn() (which is
// the most-recent connection — wrong when two browsers are both
// BLE-connected concurrently).
static uint16_t s_active_offer_conn = 0;

typedef struct {
    event_type_t type;
    char *payload;   // malloc'd; freed by handler
} event_t;

static QueueHandle_t s_events;
static TaskHandle_t s_loop_task;

// ── BLE signaling ────────────────────────────────────────────────────────

#define BLE_SIG_MAX_OFFER 8192    // SDP rarely exceeds 5 KB; cap defends RAM
#define BLE_SIG_CHUNK     100     // small enough to fit any plausible MTU

// Reassembly buffer for incoming chunked offer. Owned by the BLE host
// task between begin and commit; ownership transfers to the loop task on
// commit (queued via EV_OFFER_BLE).
static char *s_ble_offer_buf = NULL;
static size_t s_ble_offer_total = 0;
static size_t s_ble_offer_received = 0;

static void send_ble_signal_error(const char *msg) {
    uint8_t buf[1 + 64];
    buf[0] = 0xFF;
    size_t n = strnlen(msg, sizeof(buf) - 1);
    memcpy(buf + 1, msg, n);
    gatt_svr_signal_send(s_active_offer_conn, buf, 1 + n);
}

static void send_answer_via_ble(const char *sdp) {
    size_t total = strlen(sdp);
    ESP_LOGI(TAG, "send_answer_via_ble: total=%u conn=%u",
             (unsigned)total, (unsigned)s_active_offer_conn);
    if (total == 0 || total > 0xFFFF) {
        send_ble_signal_error("answer size out of range");
        return;
    }
    uint8_t begin[3] = { 0x01, (uint8_t)(total >> 8), (uint8_t)(total & 0xff) };
    gatt_svr_signal_send(s_active_offer_conn, begin, 3);

    uint8_t chunk[1 + BLE_SIG_CHUNK];
    chunk[0] = 0x02;
    size_t offset = 0;
    while (offset < total) {
        size_t take = total - offset > BLE_SIG_CHUNK ? BLE_SIG_CHUNK : total - offset;
        memcpy(chunk + 1, sdp + offset, take);
        gatt_svr_signal_send(s_active_offer_conn, chunk, 1 + take);
        offset += take;
        // Pace notifies — same reasoning as snapshot's 40 ms gap, but our
        // chunk size is much smaller so 5 ms is enough for the BLE tx
        // queue to drain between sends.
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    uint8_t commit[1] = { 0x03 };
    gatt_svr_signal_send(s_active_offer_conn, commit, 1);
    ESP_LOGI(TAG, "send_answer_via_ble: done (%u chunks)",
             (unsigned)((total + BLE_SIG_CHUNK - 1) / BLE_SIG_CHUNK));
}

void webrtc_peer_handle_ble_signal_write(uint16_t from_conn, const uint8_t *buf, size_t len) {
    if (len == 0) return;
    uint8_t op = buf[0];
    if (op == 0x01) {
        if (len < 3) { send_ble_signal_error("bad begin"); return; }
        // Bind the answer to this writer's conn for the rest of the
        // handshake. Captured here (not at op==0x03) so error frames
        // sent during reassembly route to the right central.
        s_active_offer_conn = from_conn;
        size_t total = ((size_t)buf[1] << 8) | buf[2];
        ESP_LOGI(TAG, "ble signal: begin total=%u conn=%u",
                 (unsigned)total, (unsigned)from_conn);
        if (total == 0 || total > BLE_SIG_MAX_OFFER) {
            send_ble_signal_error("offer size out of range");
            return;
        }
        free(s_ble_offer_buf);
        s_ble_offer_buf = malloc(total + 1);
        if (!s_ble_offer_buf) {
            send_ble_signal_error("oom");
            s_ble_offer_total = 0;
            return;
        }
        s_ble_offer_total = total;
        s_ble_offer_received = 0;
    } else if (op == 0x02) {
        if (!s_ble_offer_buf) return;
        size_t add = len - 1;
        if (s_ble_offer_received + add > s_ble_offer_total) {
            free(s_ble_offer_buf);
            s_ble_offer_buf = NULL;
            send_ble_signal_error("chunk overflow");
            return;
        }
        memcpy(s_ble_offer_buf + s_ble_offer_received, buf + 1, add);
        s_ble_offer_received += add;
    } else if (op == 0x03) {
        if (!s_ble_offer_buf || s_ble_offer_received != s_ble_offer_total) {
            free(s_ble_offer_buf);
            s_ble_offer_buf = NULL;
            send_ble_signal_error("offer incomplete");
            return;
        }
        ESP_LOGI(TAG, "ble signal: commit, offer assembled %u B",
                 (unsigned)s_ble_offer_total);
        s_ble_offer_buf[s_ble_offer_total] = 0;
        // Hand ownership to the loop task via the event queue. If queue
        // send fails, free here; otherwise the loop task frees after
        // handling.
        event_t ev = { .type = EV_OFFER_BLE, .payload = s_ble_offer_buf };
        if (xQueueSend(s_events, &ev, 0) != pdTRUE) {
            ESP_LOGW(TAG, "event queue full; dropping BLE offer");
            free(s_ble_offer_buf);
        }
        s_ble_offer_buf = NULL;
        s_ble_offer_total = 0;
        s_ble_offer_received = 0;
    }
}

// ── peer connection lifecycle ────────────────────────────────────────────

static void stop_video_streaming(void);

static void on_state_change(PeerConnectionState state, void *ud) {
    ESP_LOGI(TAG, "pc state: %s", peer_connection_state_to_string(state));
    if (state == PEER_CONNECTION_DISCONNECTED
        || state == PEER_CONNECTION_FAILED
        || state == PEER_CONNECTION_CLOSED) {
        stop_video_streaming();
    }
}

// ── data channels ────────────────────────────────────────────────────────
//
// libpeer's onmessage callback drops the SCTP PPID (text vs binary) before
// invoking us — peer_connection.h's signature has no type field. We
// disambiguate by content: control frames are JSON starting with `{`,
// payload chunks are arbitrary bytes. ESP32 firmware bins start with the
// 0xE9 magic; JPEG frames start with 0xFFD8; neither collides with `{`
// (0x7B). Same heuristic as several other libpeer ESP32 integrations.

static void send_dc_text(const char *label, const char *text) {
    if (!s_pc) return;
    uint16_t sid;
    if (peer_connection_lookup_sid(s_pc, (char *)label, &sid) != 0) return;
    peer_connection_datachannel_send_sid(s_pc, (char *)text, strlen(text), sid);
}

static void handle_ota_dc(const char *msg, size_t len) {
    if (len == 0) return;
    if (msg[0] == '{') {
        cJSON *root = cJSON_ParseWithLength(msg, len);
        if (!root) return;
        cJSON *type = cJSON_GetObjectItem(root, "type");
        if (cJSON_IsString(type)) {
            const char *t = type->valuestring;
            if (strcmp(t, "begin") == 0) {
                cJSON *size = cJSON_GetObjectItem(root, "size");
                size_t total = cJSON_IsNumber(size) ? (size_t)size->valuedouble : 0;
                if (ota_http_begin(total) != ESP_OK) {
                    send_dc_text("ota", "{\"type\":\"error\",\"error\":\"ota_begin failed\"}");
                }
            } else if (strcmp(t, "commit") == 0) {
                if (ota_http_commit() == ESP_OK) {
                    // Match the Pi's reply shape so dashboard parsing
                    // doesn't need a per-platform branch. The follow-up
                    // BLE apply-staged-ota verb won't reach us before
                    // schedule_restart fires (500 ms) — chip reboots
                    // straight into the new firmware. Dashboard sees a
                    // BLE write fail; the next reconnect shows the new
                    // version. Acceptable until the dashboard branches
                    // on fwType to skip the apply step for ESP32.
                    send_dc_text("ota", "{\"type\":\"staged\"}");
                } else {
                    send_dc_text("ota", "{\"type\":\"error\",\"error\":\"ota_commit failed\"}");
                }
            } else if (strcmp(t, "abort") == 0) {
                ota_http_abort();
            }
        }
        cJSON_Delete(root);
    } else {
        // Binary chunk — append to OTA partition.
        if (ota_http_write((const uint8_t *)msg, len) != ESP_OK) {
            send_dc_text("ota", "{\"type\":\"error\",\"error\":\"ota_write failed\"}");
        }
    }
}

// ── video over data channel ──────────────────────────────────────────────
//
// Browsers can't decode MJPEG WebRTC video tracks (only VP8/VP9/H.264/AV1
// are negotiable codecs), so we route JPEG frames as binary on a data
// channel instead. Dashboard receives ArrayBuffers and renders via
// URL.createObjectURL or a 2D canvas. Same end-to-end behavior as
// /stream over HTTP, but P2P + no Mixed Content / PNA fragility.
//
// Single SCTP message per frame; SCTP's universal floor is 16 KB, so the
// camera profile must stay at compact (QVGA q=15, ~5-10 KB) for reliable
// delivery. Standard/full can exceed the limit and fragment unreliably.
//
// The frame pump runs INSIDE rtc_loop_task instead of its own task — by
// the time a video session starts, internal DRAM is fragmented enough
// that no contiguous 4 KB block remains for a fresh task stack, and an
// SPIRAM-stacked task panics during DTLS/SRTP encrypt (cache-coherence
// quirks on classic ESP32). Pacing by esp_timer_get_time() keeps it
// independent of vTaskDelay quantization.

static volatile bool s_video_active = false;
static int s_video_fps = 10;
static int64_t s_video_last_frame_us = 0;
static uint16_t s_video_frame_id = 0;

// Chunk size below SCTP_MTU=1200 minus DTLS+header overhead — each
// peer_connection_datachannel_send_sid hits one lwIP pbuf, no fragmentation
// burst, no pool-exhaustion cascade. Browser reassembles by frame_id.
//
// Wire format per chunk (binary on data channel):
//   [0..1] frame_id  u16 BE
//   [2]    chunk_idx u8
//   [3]    total_chunks u8
//   [4..]  jpeg payload (≤ VIDEO_CHUNK_PAYLOAD bytes)
#define VIDEO_CHUNK_PAYLOAD  900
#define VIDEO_CHUNK_HEADER   4

static int s_video_frame_count = 0;
static void video_pump_tick(void) {
    if (!s_video_active || !camera_ready() || !s_pc) return;
    int64_t now = esp_timer_get_time();
    int64_t period_us = (int64_t)1000000 / (s_video_fps > 0 ? s_video_fps : 10);
    if (now - s_video_last_frame_us < period_us) return;
    s_video_last_frame_us = now;

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        ESP_LOGW(TAG, "video pump: fb_get failed");
        return;
    }
    uint16_t sid = 0;
    int rc = peer_connection_lookup_sid(s_pc, "video", &sid);
    if (rc != 0) {
        ESP_LOGW(TAG, "video pump: lookup_sid rc=%d", rc);
        esp_camera_fb_return(fb);
        return;
    }

    size_t total_chunks = (fb->len + VIDEO_CHUNK_PAYLOAD - 1) / VIDEO_CHUNK_PAYLOAD;
    if (total_chunks > 255) {
        // Frame too big for u8 chunk_idx field. Drop and warn — typical
        // compact-profile JPEGs are 2-15 KB so this caps at ~225 KB.
        ESP_LOGW(TAG, "video pump: frame too big (%u B, %u chunks)",
                 (unsigned)fb->len, (unsigned)total_chunks);
        esp_camera_fb_return(fb);
        return;
    }

    s_video_frame_id++;
    uint8_t buf[VIDEO_CHUNK_HEADER + VIDEO_CHUNK_PAYLOAD];
    bool full_send = true;
    for (size_t chunk = 0; chunk < total_chunks; chunk++) {
        size_t off  = chunk * VIDEO_CHUNK_PAYLOAD;
        size_t plen = fb->len - off;
        if (plen > VIDEO_CHUNK_PAYLOAD) plen = VIDEO_CHUNK_PAYLOAD;
        buf[0] = (s_video_frame_id >> 8) & 0xff;
        buf[1] =  s_video_frame_id       & 0xff;
        buf[2] = (uint8_t)chunk;
        buf[3] = (uint8_t)total_chunks;
        memcpy(buf + VIDEO_CHUNK_HEADER, fb->buf + off, plen);
        int sent = peer_connection_datachannel_send_sid(
            s_pc, (char *)buf, VIDEO_CHUNK_HEADER + plen, sid);
        if (sent <= 0 || (size_t)sent < VIDEO_CHUNK_HEADER + plen) full_send = false;
        // Yield between chunks so lwIP's pbuf pool drains. 2ms × ~5
        // chunks = 10ms total send time, well within 200ms/frame at 5fps.
        if (chunk + 1 < total_chunks) vTaskDelay(pdMS_TO_TICKS(2));
    }

    s_video_frame_count++;
    if ((s_video_frame_count % 10) == 0) {
        ESP_LOGI(TAG, "video pump: frame #%d (id=%u), %u B in %u chunks → sid=%u %s",
                 s_video_frame_count, s_video_frame_id, (unsigned)fb->len,
                 (unsigned)total_chunks, sid, full_send ? "ok" : "partial");
    }
    esp_camera_fb_return(fb);
}

static void start_video_streaming(int fps) {
    s_video_fps = (fps > 0 && fps <= 30) ? fps : 10;
    s_video_active = true;
    s_video_last_frame_us = 0;  // fire on the next loop tick
    ESP_LOGI(TAG, "video stream started, fps=%d", s_video_fps);
}

static void stop_video_streaming(void) {
    if (s_video_active) ESP_LOGI(TAG, "video stream stopped");
    s_video_active = false;
}

static void handle_video_dc(const char *msg, size_t len) {
    ESP_LOGI(TAG, "video dc msg: %.*s", (int)(len > 80 ? 80 : len), msg);
    if (len == 0 || msg[0] != '{') return;
    cJSON *root = cJSON_ParseWithLength(msg, len);
    if (!root) {
        ESP_LOGW(TAG, "video dc: bad json");
        return;
    }
    cJSON *type = cJSON_GetObjectItem(root, "type");
    if (cJSON_IsString(type)) {
        const char *t = type->valuestring;
        ESP_LOGI(TAG, "video dc type=%s", t);
        if (strcmp(t, "start") == 0) {
            cJSON *fps = cJSON_GetObjectItem(root, "fps");
            int f = cJSON_IsNumber(fps) ? (int)fps->valuedouble : 10;
            start_video_streaming(f);
        } else if (strcmp(t, "stop") == 0) {
            stop_video_streaming();
        }
    }
    cJSON_Delete(root);
}

static void on_dc_message(char *msg, size_t len, void *ud, uint16_t sid) {
    if (!s_pc) {
        ESP_LOGW(TAG, "dc msg sid=%u len=%u: no PC", (unsigned)sid, (unsigned)len);
        return;
    }
    char *label = peer_connection_lookup_sid_label(s_pc, sid);
    ESP_LOGI(TAG, "dc msg sid=%u len=%u label=%s",
             (unsigned)sid, (unsigned)len, label ? label : "<null>");
    if (!label) return;
    if (strcmp(label, "ota") == 0) {
        handle_ota_dc(msg, len);
    } else if (strcmp(label, "video") == 0) {
        handle_video_dc(msg, len);
    }
    // Other labels (logs, ops) drop here — wire in 2.D.2.x as needed.
}

static void on_dc_open(void *ud)  { ESP_LOGI(TAG, "data channel opened"); }
static void on_dc_close(void *ud) {
    ESP_LOGI(TAG, "data channel closed");
    // Stop video on any close — single-PC model means a closed channel
    // is effectively session end.
    stop_video_streaming();
}

// Strip lines libpeer can't process from the offer SDP. Dashboard now
// emits Cloudflare TURN candidates (TCP + TLS, plus IPv6 if the host
// has it); libpeer's UDP-only ICE agent panicked on LoadProhibited
// while parsing them ("Only UDP transport is supported" was the last
// error before the crash). Net-out: keep IPv4 UDP candidates only,
// drop everything else. The output buffer is sized for the input plus
// terminator — we only ever shrink. Caller frees out.
static char *filter_sdp_for_libpeer(const char *sdp) {
    size_t in_len = strlen(sdp);
    char *out = malloc(in_len + 1);
    if (!out) return NULL;
    size_t o = 0;
    const char *p = sdp;
    int dropped = 0;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t line_len = eol ? (size_t)(eol - p + 1) : strlen(p);
        // a=candidate:... <foundation> <component> <proto> <pri> <addr> <port> typ <type> ...
        bool drop = false;
        if (strncmp(p, "a=candidate:", 12) == 0) {
            // Find the proto field (4th whitespace-separated token).
            const char *q = p + 12;
            int tok = 0;
            while (q < p + line_len && tok < 2) {
                while (q < p + line_len && *q != ' ') q++;
                while (q < p + line_len && *q == ' ') q++;
                tok++;
            }
            // q now points at proto. tcp/TCP candidates: drop.
            if (q < p + line_len && (q[0] == 't' || q[0] == 'T')
                                  && (q[1] == 'c' || q[1] == 'C')
                                  && (q[2] == 'p' || q[2] == 'P')) {
                drop = true;
            } else {
                // IPv6 detection: address comes 2 fields after proto. Walk
                // to it and check for a colon (IPv4 has dots, IPv6 has colons).
                int adv = 0;
                while (q < p + line_len && adv < 3) {
                    while (q < p + line_len && *q != ' ') q++;
                    while (q < p + line_len && *q == ' ') q++;
                    adv++;
                }
                if (q < p + line_len && memchr(q, ':',
                        (size_t)((p + line_len) - q)) != NULL) {
                    // Cheap heuristic: candidate addr field with a colon = IPv6.
                    // (IPv4 dotted-quad never has ':'.) Dropping IPv6 even when
                    // libpeer might have parsed it — UDP-only stack means we
                    // don't gain anything from v6 anyway.
                    drop = true;
                }
            }
        }
        if (drop) {
            dropped++;
        } else {
            memcpy(out + o, p, line_len);
            o += line_len;
        }
        if (!eol) break;
        p = eol + 1;
    }
    out[o] = 0;
    if (dropped) ESP_LOGI(TAG, "filtered SDP: dropped %d candidate line(s)", dropped);
    return out;
}

static void handle_offer(const char *sdp) {
    ESP_LOGI(TAG, "handle_offer: sdp len=%u", (unsigned)strlen(sdp));
    if (s_pc) {
        // Last-window-wins: a second browser opening WebRTC kicks the
        // first one's session. The video pump references s_pc on every
        // tick, so stop it BEFORE close/destroy or it'll dereference a
        // freed handle. Brief delay lets libpeer's ICE/DTLS sockets
        // unbind before the new agent gathers candidates on the same
        // ports — without it the new ICE times out (observed on a 2nd
        // incognito window post-2.F.2).
        stop_video_streaming();
        peer_connection_close(s_pc);
        peer_connection_destroy(s_pc);
        s_pc = NULL;
        vTaskDelay(pdMS_TO_TICKS(500));
    }

    // STUN + Cloudflare TURN (UDP only — libpeer's TURN client doesn't
    // do TCP). turn_creds runs in the background and may not have minted
    // credentials yet (WiFi just up, proxy slow, etc.); on miss we fall
    // through to STUN-only and the chip works on LAN-friendly networks
    // but fails on apartment-WiFi-shaped client-isolated/CGNAT ones.
    // turn_url is pre-resolved to an IP literal so libpeer's create_answer
    // doesn't synchronously getaddrinfo() inside the BLE 30s window.
    PeerConfiguration cfg = {
        .video_codec = CODEC_NONE,    // 2.D.3 routes frames as binary on a data channel
        .audio_codec = CODEC_NONE,
        .datachannel = DATA_CHANNEL_BINARY,
    };
    cfg.ice_servers[0].urls = "stun:stun.l.google.com:19302";
    const char *turn_user = turn_creds_username();
    const char *turn_pass = turn_creds_credential();
    const char *turn_url  = turn_creds_url();
    if (turn_user && turn_pass && turn_url) {
        cfg.ice_servers[1].urls       = turn_url;
        cfg.ice_servers[1].username   = turn_user;
        cfg.ice_servers[1].credential = turn_pass;
        ESP_LOGI(TAG, "ice_servers: STUN + Cloudflare TURN(%s)", turn_url);
    } else {
        ESP_LOGW(TAG, "ice_servers: STUN-only (turn_creds not ready)");
    }
    s_pc = peer_connection_create(&cfg);
    if (!s_pc) {
        ESP_LOGE(TAG, "peer_connection_create failed");
        return;
    }
    peer_connection_oniceconnectionstatechange(s_pc, on_state_change);
    peer_connection_ondatachannel(s_pc, on_dc_message, on_dc_open, on_dc_close);

    ESP_LOGI(TAG, "handle_offer: setting remote description");
    char *filtered = filter_sdp_for_libpeer(sdp);
    peer_connection_set_remote_description(s_pc, filtered ? filtered : sdp, SDP_TYPE_OFFER);
    free(filtered);
    ESP_LOGI(TAG, "handle_offer: creating answer");
    const char *answer = peer_connection_create_answer(s_pc);
    if (!answer || !answer[0]) {
        ESP_LOGE(TAG, "create_answer empty");
        send_ble_signal_error("create_answer failed");
        return;
    }
    ESP_LOGI(TAG, "handle_offer: answer ready, %u B", (unsigned)strlen(answer));
    send_answer_via_ble(answer);
}

static void handle_ice(const char *candidate) {
    if (!s_pc || !candidate || !candidate[0]) return;
    // libpeer takes a non-const char *; the API doesn't mutate but we
    // need a writable copy.
    char *copy = strdup(candidate);
    if (!copy) return;
    peer_connection_add_ice_candidate(s_pc, copy);
    free(copy);
}

// ── inbound dispatcher ───────────────────────────────────────────────────

static void post_event(event_type_t t, const char *str) {
    if (!str) return;
    char *copy = strdup(str);
    if (!copy) return;
    event_t ev = { .type = t, .payload = copy };
    if (xQueueSend(s_events, &ev, 0) != pdTRUE) {
        free(copy);
    }
}

// ── loop task ────────────────────────────────────────────────────────────

static void loop_task_fn(void *arg) {
    event_t ev;
    while (1) {
        while (xQueueReceive(s_events, &ev, 0) == pdTRUE) {
            switch (ev.type) {
                case EV_OFFER_BLE: handle_offer(ev.payload);  break;
                case EV_ICE:       handle_ice(ev.payload);    break;
            }
            free(ev.payload);
        }
        if (s_pc) peer_connection_loop(s_pc);
        video_pump_tick();
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// ── init ─────────────────────────────────────────────────────────────────

void webrtc_peer_init(const char *robot_name) {
    (void)robot_name;
    if (peer_init() != 0) {
        ESP_LOGE(TAG, "peer_init failed");
        return;
    }

    s_events = xQueueCreate(8, sizeof(event_t));
    if (!s_events) { ESP_LOGE(TAG, "queue create failed"); return; }

    // 8 KB stack — peer_connection_loop dives into mbedTLS / SCTP /
    // SRTP. Bump if the DTLS handshake stack-overflows in practice.
    xTaskCreate(loop_task_fn, "rtc_loop", 8192, NULL, 5, &s_loop_task);
    ESP_LOGI(TAG, "rtc init: BLE-signaled WebRTC ready");
}
