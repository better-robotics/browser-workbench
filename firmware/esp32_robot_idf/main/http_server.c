#include "http_server.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"

#include "ota.h"
#include "version.h"

static const char *TAG = "http";

static httpd_handle_t s_server = NULL;
static const char *s_robot_name = "?";

httpd_handle_t http_server_handle(void) { return s_server; }

// Modern Chrome (M130+) under Private Network Access requires the
// Access-Control-Allow-Origin to *echo the requesting Origin* rather
// than `*` when the page is HTTPS and the target is http://<private-IP>.
// Echo-with-Vary keeps caches sane.
static void set_cors_headers(httpd_req_t *req) {
    char origin[128] = {0};
    if (httpd_req_get_hdr_value_str(req, "Origin", origin, sizeof(origin)) == ESP_OK
        && origin[0] != 0) {
        httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", origin);
        httpd_resp_set_hdr(req, "Vary", "Origin");
    } else {
        httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    }
}

static esp_err_t options_preflight_handler(httpd_req_t *req) {
    set_cors_headers(req);
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "Content-Type");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Private-Network", "true");
    httpd_resp_set_hdr(req, "Access-Control-Max-Age", "86400");
    httpd_resp_set_status(req, "204 No Content");
    httpd_resp_send(req, NULL, 0);
    return ESP_OK;
}

static esp_err_t health_handler(httpd_req_t *req) {
    char ip_str[16] = "0.0.0.0";
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif) {
        esp_netif_ip_info_t info;
        if (esp_netif_get_ip_info(netif, &info) == ESP_OK) {
            snprintf(ip_str, sizeof(ip_str), IPSTR, IP2STR(&info.ip));
        }
    }
    char body[192];
    int n = snprintf(body, sizeof(body),
        "{\"ok\":true,\"type\":\"esp32\",\"robotId\":\"%s\",\"ip\":\"%s\","
        "\"uptime_s\":%lld,\"sha\":\"%s\"}",
        s_robot_name, ip_str, esp_timer_get_time() / 1000000, GIT_SHA);
    set_cors_headers(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_send(req, body, n);
    return ESP_OK;
}

static esp_err_t ota_post_handler(httpd_req_t *req) {
    int total = req->content_len;
    if (total <= 0 || total > 4 * 1024 * 1024) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid size");
        return ESP_FAIL;
    }
    if (ota_http_begin((size_t)total) != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "ota_begin");
        return ESP_FAIL;
    }

    char buf[2048];
    int received = 0;
    while (received < total) {
        int want = total - received;
        if (want > (int)sizeof(buf)) want = sizeof(buf);
        int r = httpd_req_recv(req, buf, want);
        if (r <= 0) {
            ota_http_abort();
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "recv");
            return ESP_FAIL;
        }
        if (ota_http_write((uint8_t *)buf, r) != ESP_OK) {
            ota_http_abort();
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "write");
            return ESP_FAIL;
        }
        received += r;
    }
    if (ota_http_commit() != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "commit");
        return ESP_FAIL;
    }
    set_cors_headers(req);
    httpd_resp_set_type(req, "text/plain");
    httpd_resp_send(req, "OK", 2);
    return ESP_OK;
}

void http_server_init(const char *robot_name) {
    s_robot_name = robot_name;
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.server_port = 81;
    cfg.stack_size = 8192;            // /ota recv loop + OTA write — 4KB default is tight
    cfg.max_uri_handlers = 12;        // /stream + /snapshot land in 2.C.4
    cfg.lru_purge_enable = true;

    if (httpd_start(&s_server, &cfg) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        return;
    }

    static const httpd_uri_t health_get = {
        .uri = "/health", .method = HTTP_GET, .handler = health_handler,
    };
    static const httpd_uri_t health_options = {
        .uri = "/health", .method = HTTP_OPTIONS, .handler = options_preflight_handler,
    };
    static const httpd_uri_t ota_post = {
        .uri = "/ota", .method = HTTP_POST, .handler = ota_post_handler,
    };
    static const httpd_uri_t ota_options = {
        .uri = "/ota", .method = HTTP_OPTIONS, .handler = options_preflight_handler,
    };
    httpd_register_uri_handler(s_server, &health_get);
    httpd_register_uri_handler(s_server, &health_options);
    httpd_register_uri_handler(s_server, &ota_post);
    httpd_register_uri_handler(s_server, &ota_options);

    ESP_LOGI(TAG, "ready on :81 (/health, /ota)");
}
