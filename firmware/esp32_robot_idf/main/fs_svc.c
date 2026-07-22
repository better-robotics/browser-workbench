// On-robot file service — LittleFS on the `storage` partition, driven over
// BLE. Two characteristics carry a 1-byte leading opcode (protocol_constants.h,
// group fs_transfer):
//
//   FS_OP   (browser -> board, write):
//     FS_OP_JSON   [json]   control request {op,...}  (see verbs below)
//     FS_OP_WBYTES [bytes]  raw file bytes for the open write session
//
//   FS_DATA (board -> browser, notify):
//     JSON reply stream    FS_RSP_BEGIN[u32 len] / FS_RSP_CHUNK / FS_RSP_END
//     file-read stream     FS_FILE_BEGIN[u32 len] / FS_FILE_CHUNK / FS_FILE_END
//
// Verbs (FS_OP_JSON): list, stat{name}, read{name}, delete{name},
// rename{name,to}, write{name,size,crc32}, write-commit, write-abort.
// Every reply is a JSON object echoing "op" with ok:true, or ok:false +
// "error":<code> so the UI can map the failure. read replies with a JSON
// header ({op:"read",ok,name,size}) then the binary file stream.
//
// A write is browser->board bulk transfer, acked only after the LittleFS
// commit — a dropped link mid-stream leaves no half-file presented as
// whole: the length + CRC32 are verified before the file is created, so a
// short or corrupt transfer is rejected, not stored. Must stay in sync
// with docs/fs/fs-client.js (same opcodes, same crc32).
#include "fs_svc.h"

#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "cJSON.h"
#include "esp_littlefs.h"
#include "esp_log.h"
#include "esp_partition.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "gatt_svr.h"
#include "protocol_constants.h"

static const char *TAG = "fs_svc";

#define FS_BASE_PATH       "/fs"
#define FS_PART_LABEL      "storage"

// Quotas — every one returns a distinct error code the UI surfaces.
#define FS_MAX_FILE_SIZE   (32 * 1024)
#define FS_MAX_FILES       64
#define FS_MAX_NAME_LEN    48

// FS_DATA notify chunking. CHUNK_BYTES (protocol_constants.h, shared with
// snapshot) is the conservative payload bound under a desktop-Chrome MTU;
// 40 ms pacing matches snapshot.c's tested NimBLE tx-queue headroom.
#define FS_CHUNK_BYTES         CHUNK_BYTES
#define FS_INTER_CHUNK_DELAY_MS 40

static bool s_available = false;

// Single write session — one upload at a time (the client serializes per
// robot). Buffer is heap-allocated on write-begin, freed on commit/abort.
static uint8_t *s_wbuf = NULL;
static size_t   s_wcap = 0;   // expected total (== allocation)
static size_t   s_wgot = 0;   // bytes appended so far
static uint32_t s_wcrc = 0;   // expected CRC32
static char     s_wname[FS_MAX_NAME_LEN + 1];

// Worker task + queue. JSON control frames are copied onto the queue so the
// BLE host callback never blocks on the reply's 40 ms chunk pacing.
static QueueHandle_t s_q = NULL;
typedef struct { uint8_t *buf; size_t len; } fs_msg_t;

// Standard reflected CRC-32 (IEEE, poly 0xEDB88320 = reflection of
// 0x04C11DB7, init/final ~0 — matches zlib). Hand-rolled rather than
// esp_crc32_le so the convention is unambiguous and provably matches
// docs/fs/fs-client.js's crc32 — cross-file invariant.
static uint32_t crc32(const uint8_t *data, size_t len) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int k = 0; k < 8; k++)
            crc = (crc >> 1) ^ (0xEDB88320u & (uint32_t)(-(int32_t)(crc & 1u)));
    }
    return crc ^ 0xFFFFFFFFu;
}

// Flat namespace: [A-Za-z0-9._-], 1..FS_MAX_NAME_LEN, no "." / ".." / "/".
static bool valid_name(const char *n) {
    if (!n) return false;
    size_t len = strlen(n);
    if (len == 0 || len > FS_MAX_NAME_LEN) return false;
    if (strcmp(n, ".") == 0 || strcmp(n, "..") == 0) return false;
    for (size_t i = 0; i < len; i++) {
        char c = n[i];
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
        if (!ok) return false;
    }
    return true;
}

static void path_for(const char *name, char *out, size_t out_len) {
    snprintf(out, out_len, FS_BASE_PATH "/%s", name);
}

// Count regular files under /fs (for the FS_MAX_FILES quota).
static int file_count(void) {
    DIR *d = opendir(FS_BASE_PATH);
    if (!d) return 0;
    int n = 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (e->d_type != DT_DIR) n++;
    }
    closedir(d);
    return n;
}

static bool file_exists(const char *name) {
    char path[FS_MAX_NAME_LEN + 8];
    path_for(name, path, sizeof(path));
    struct stat st;
    return stat(path, &st) == 0;
}

// Stream `data` as a BEGIN[u32 len] / CHUNK* / END framed transfer on
// FS_DATA. Used for both the JSON reply stream and (from a file) the read
// stream — the opcodes differ, the framing is identical.
static void send_stream(uint8_t op_begin, uint8_t op_chunk, uint8_t op_end,
                        const uint8_t *data, size_t len) {
    uint8_t hdr[5] = { op_begin,
                       (uint8_t)(len >> 24), (uint8_t)(len >> 16),
                       (uint8_t)(len >> 8),  (uint8_t)(len) };
    gatt_svr_fs_send(hdr, sizeof(hdr));
    vTaskDelay(pdMS_TO_TICKS(FS_INTER_CHUNK_DELAY_MS));

    uint8_t chunk[1 + FS_CHUNK_BYTES];
    chunk[0] = op_chunk;
    size_t sent = 0;
    while (sent < len) {
        size_t take = len - sent;
        if (take > FS_CHUNK_BYTES) take = FS_CHUNK_BYTES;
        memcpy(chunk + 1, data + sent, take);
        gatt_svr_fs_send(chunk, 1 + take);
        sent += take;
        vTaskDelay(pdMS_TO_TICKS(FS_INTER_CHUNK_DELAY_MS));
    }

    uint8_t end = op_end;
    gatt_svr_fs_send(&end, 1);
}

// Serialize `root` and stream it as the JSON reply. Takes ownership: frees
// both the cJSON tree and the printed buffer.
static void send_json(cJSON *root) {
    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!json) return;
    send_stream(FS_RSP_BEGIN, FS_RSP_CHUNK, FS_RSP_END,
                (const uint8_t *)json, strlen(json));
    cJSON_free(json);
}

// {op, ok:false, error:code}. The one reply shape every failure takes.
static void send_err(const char *op, const char *code) {
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "op", op);
    cJSON_AddBoolToObject(root, "ok", false);
    cJSON_AddStringToObject(root, "error", code);
    send_json(root);
}

static void op_list(void) {
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "op", "list");
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON *arr = cJSON_AddArrayToObject(root, "files");
    DIR *d = opendir(FS_BASE_PATH);
    if (d) {
        struct dirent *e;
        while ((e = readdir(d)) != NULL) {
            if (e->d_type == DT_DIR) continue;
            char path[FS_MAX_NAME_LEN + 8];
            path_for(e->d_name, path, sizeof(path));
            struct stat st;
            cJSON *f = cJSON_CreateObject();
            cJSON_AddStringToObject(f, "name", e->d_name);
            cJSON_AddNumberToObject(f, "size", stat(path, &st) == 0 ? (double)st.st_size : 0);
            cJSON_AddItemToArray(arr, f);
        }
        closedir(d);
    }
    size_t total = 0, used = 0;
    esp_littlefs_info(FS_PART_LABEL, &total, &used);
    cJSON_AddNumberToObject(root, "used", (double)used);
    cJSON_AddNumberToObject(root, "total", (double)total);
    send_json(root);
}

static void op_stat(const char *name) {
    if (!valid_name(name)) { send_err("stat", "bad-name"); return; }
    char path[FS_MAX_NAME_LEN + 8];
    path_for(name, path, sizeof(path));
    struct stat st;
    if (stat(path, &st) != 0) { send_err("stat", "not-found"); return; }
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "op", "stat");
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON_AddStringToObject(root, "name", name);
    cJSON_AddNumberToObject(root, "size", (double)st.st_size);
    send_json(root);
}

// read: JSON header ({op:read,ok,name,size}) then the binary file stream.
// Streams straight from the file so a 32 KB read needs no 32 KB heap block.
static void op_read(const char *name) {
    if (!valid_name(name)) { send_err("read", "bad-name"); return; }
    char path[FS_MAX_NAME_LEN + 8];
    path_for(name, path, sizeof(path));
    struct stat st;
    if (stat(path, &st) != 0) { send_err("read", "not-found"); return; }
    FILE *f = fopen(path, "rb");
    if (!f) { send_err("read", "io"); return; }
    size_t size = (size_t)st.st_size;

    cJSON *hdr = cJSON_CreateObject();
    cJSON_AddStringToObject(hdr, "op", "read");
    cJSON_AddBoolToObject(hdr, "ok", true);
    cJSON_AddStringToObject(hdr, "name", name);
    cJSON_AddNumberToObject(hdr, "size", (double)size);
    send_json(hdr);

    uint8_t begin[5] = { FS_FILE_BEGIN,
                         (uint8_t)(size >> 24), (uint8_t)(size >> 16),
                         (uint8_t)(size >> 8),  (uint8_t)(size) };
    gatt_svr_fs_send(begin, sizeof(begin));
    vTaskDelay(pdMS_TO_TICKS(FS_INTER_CHUNK_DELAY_MS));

    uint8_t chunk[1 + FS_CHUNK_BYTES];
    chunk[0] = FS_FILE_CHUNK;
    size_t n;
    while ((n = fread(chunk + 1, 1, FS_CHUNK_BYTES, f)) > 0) {
        gatt_svr_fs_send(chunk, 1 + n);
        vTaskDelay(pdMS_TO_TICKS(FS_INTER_CHUNK_DELAY_MS));
    }
    fclose(f);

    uint8_t end = FS_FILE_END;
    gatt_svr_fs_send(&end, 1);
}

static void op_delete(const char *name) {
    if (!valid_name(name)) { send_err("delete", "bad-name"); return; }
    char path[FS_MAX_NAME_LEN + 8];
    path_for(name, path, sizeof(path));
    if (remove(path) != 0) { send_err("delete", "not-found"); return; }
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "op", "delete");
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON_AddStringToObject(root, "name", name);
    send_json(root);
}

static void op_rename(const char *name, const char *to) {
    if (!valid_name(name) || !valid_name(to)) { send_err("rename", "bad-name"); return; }
    char from_path[FS_MAX_NAME_LEN + 8], to_path[FS_MAX_NAME_LEN + 8];
    path_for(name, from_path, sizeof(from_path));
    path_for(to, to_path, sizeof(to_path));
    if (!file_exists(name)) { send_err("rename", "not-found"); return; }
    if (rename(from_path, to_path) != 0) { send_err("rename", "io"); return; }
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "op", "rename");
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON_AddStringToObject(root, "name", name);
    cJSON_AddStringToObject(root, "to", to);
    send_json(root);
}

static void write_session_free(void) {
    if (s_wbuf) { free(s_wbuf); s_wbuf = NULL; }
    s_wcap = s_wgot = s_wcrc = 0;
    s_wname[0] = '\0';
}

// Open a write session: validate name/size/quota, allocate the receive
// buffer, ack. The client streams FS_OP_WBYTES only after this ack, so the
// buffer is guaranteed live before the first chunk lands.
static void op_write_begin(const char *name, size_t size, uint32_t crc) {
    if (!valid_name(name)) { send_err("write", "bad-name"); return; }
    if (size > FS_MAX_FILE_SIZE) { send_err("write", "too-big"); return; }
    if (!file_exists(name) && file_count() >= FS_MAX_FILES) { send_err("write", "too-many"); return; }

    write_session_free();
    // malloc(0) is implementation-defined; guard so a zero-byte file (valid)
    // doesn't hinge on it. 1-byte alloc is a harmless placeholder.
    s_wbuf = malloc(size ? size : 1);
    if (!s_wbuf) { send_err("write", "fs-full"); return; }
    s_wcap = size;
    s_wgot = 0;
    s_wcrc = crc;
    strncpy(s_wname, name, FS_MAX_NAME_LEN);
    s_wname[FS_MAX_NAME_LEN] = '\0';

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "op", "write");
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON_AddStringToObject(root, "name", name);
    send_json(root);
}

// Verify the fully-received buffer against the declared length + CRC, then
// commit to LittleFS. The file is only created here — a short or corrupt
// stream is rejected before anything hits the drive.
static void op_write_commit(void) {
    if (!s_wbuf) { send_err("write-commit", "no-session"); return; }
    if (s_wgot != s_wcap) { send_err("write-commit", "size-mismatch"); write_session_free(); return; }
    if (crc32(s_wbuf, s_wgot) != s_wcrc) { send_err("write-commit", "bad-crc"); write_session_free(); return; }

    char path[FS_MAX_NAME_LEN + 8];
    path_for(s_wname, path, sizeof(path));
    FILE *f = fopen(path, "wb");
    if (!f) { send_err("write-commit", "io"); write_session_free(); return; }
    size_t wrote = s_wgot ? fwrite(s_wbuf, 1, s_wgot, f) : 0;
    // fflush + fclose so a failed flush (fs full) surfaces before we ack.
    bool ok = (wrote == s_wgot) && (fflush(f) == 0);
    fclose(f);
    if (!ok) {
        remove(path);           // don't leave a truncated file behind
        send_err("write-commit", "fs-full");
        write_session_free();
        return;
    }

    char name[FS_MAX_NAME_LEN + 1];
    strncpy(name, s_wname, sizeof(name));
    size_t size = s_wgot;
    write_session_free();

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "op", "write-commit");
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON_AddStringToObject(root, "name", name);
    cJSON_AddNumberToObject(root, "size", (double)size);
    send_json(root);
}

static void op_write_abort(void) {
    write_session_free();
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "op", "write-abort");
    cJSON_AddBoolToObject(root, "ok", true);
    send_json(root);
}

static void dispatch_json(const uint8_t *buf, size_t len) {
    cJSON *root = cJSON_ParseWithLength((const char *)buf, len);
    if (!root) { ESP_LOGW(TAG, "bad JSON, ignored"); return; }
    const cJSON *op = cJSON_GetObjectItemCaseSensitive(root, "op");
    if (!cJSON_IsString(op) || !op->valuestring) { cJSON_Delete(root); return; }
    const char *name = 0;
    const cJSON *nj = cJSON_GetObjectItemCaseSensitive(root, "name");
    if (cJSON_IsString(nj)) name = nj->valuestring;

    if (!s_available) {
        // Partition absent — reply so the client gets a code, not a timeout.
        send_err(op->valuestring, "unavailable");
        cJSON_Delete(root);
        return;
    }

    if (strcmp(op->valuestring, "list") == 0) {
        op_list();
    } else if (strcmp(op->valuestring, "stat") == 0) {
        op_stat(name);
    } else if (strcmp(op->valuestring, "read") == 0) {
        op_read(name);
    } else if (strcmp(op->valuestring, "delete") == 0) {
        op_delete(name);
    } else if (strcmp(op->valuestring, "rename") == 0) {
        const cJSON *toj = cJSON_GetObjectItemCaseSensitive(root, "to");
        op_rename(name, cJSON_IsString(toj) ? toj->valuestring : 0);
    } else if (strcmp(op->valuestring, "write") == 0) {
        const cJSON *sz = cJSON_GetObjectItemCaseSensitive(root, "size");
        const cJSON *cr = cJSON_GetObjectItemCaseSensitive(root, "crc32");
        size_t size = cJSON_IsNumber(sz) ? (size_t)sz->valuedouble : 0;
        uint32_t crc = cJSON_IsNumber(cr) ? (uint32_t)cr->valuedouble : 0;
        op_write_begin(name, size, crc);
    } else if (strcmp(op->valuestring, "write-commit") == 0) {
        op_write_commit();
    } else if (strcmp(op->valuestring, "write-abort") == 0) {
        op_write_abort();
    } else {
        send_err(op->valuestring, "unknown-op");
    }
    cJSON_Delete(root);
}

static void fs_task(void *arg) {
    fs_msg_t msg;
    for (;;) {
        if (xQueueReceive(s_q, &msg, portMAX_DELAY) == pdTRUE) {
            dispatch_json(msg.buf, msg.len);
            free(msg.buf);
        }
    }
}

void fs_svc_handle_op(const uint8_t *buf, size_t len) {
    if (len == 0) return;
    uint8_t opcode = buf[0];

    if (opcode == FS_OP_WBYTES) {
        // Append synchronously — fast, no reply. Bounds-checked so a client
        // that oversends can't run past the allocated buffer.
        if (!s_wbuf) return;
        size_t payload = len - 1;
        size_t room = s_wcap - s_wgot;
        size_t take = payload < room ? payload : room;
        memcpy(s_wbuf + s_wgot, buf + 1, take);
        s_wgot += take;
        return;
    }

    if (opcode == FS_OP_JSON) {
        if (!s_q) return;
        // Copy the payload onto the queue; the task frees it. Drop on OOM /
        // full queue rather than block the BLE host callback.
        size_t payload = len - 1;
        uint8_t *copy = malloc(payload);
        if (!copy) return;
        memcpy(copy, buf + 1, payload);
        fs_msg_t msg = { .buf = copy, .len = payload };
        if (xQueueSend(s_q, &msg, 0) != pdTRUE) free(copy);
        return;
    }
}

bool fs_svc_available(void) { return s_available; }

void fs_svc_init(void) {
    // Worker task always runs — even with no partition it replies
    // "unavailable" so the client never times out on a stray op.
    s_q = xQueueCreate(4, sizeof(fs_msg_t));
    if (s_q) xTaskCreatePinnedToCore(fs_task, "fs_svc", 4096, NULL, 4, NULL, 1);

    // Boot probe by label — no partition means an app-only OTA landed on an
    // old table. Report unavailable and run everything else unchanged.
    const esp_partition_t *part = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, FS_PART_LABEL);
    if (!part) {
        ESP_LOGW(TAG, "no '%s' partition — file service unavailable", FS_PART_LABEL);
        return;
    }

    esp_vfs_littlefs_conf_t conf = {
        .base_path = FS_BASE_PATH,
        .partition_label = FS_PART_LABEL,
        .format_if_mount_failed = true,
        .dont_mount = false,
    };
    esp_err_t err = esp_vfs_littlefs_register(&conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "mount failed: %s", esp_err_to_name(err));
        return;
    }
    size_t total = 0, used = 0;
    esp_littlefs_info(FS_PART_LABEL, &total, &used);
    ESP_LOGI(TAG, "mounted %s at %s — %u/%u bytes used",
             FS_PART_LABEL, FS_BASE_PATH, (unsigned)used, (unsigned)total);
    s_available = true;
}
