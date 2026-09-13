#include "db/db.h"
#include "http/http_server.h"
#include "scanner/scanner.h"
#include "ws/ws_server.h"

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static volatile int g_running = 1;

static void on_sigterm(int signum) {
    (void) signum;
    g_running = 0;
}

static const char *getenv_default(const char *name, const char *fallback) {
    const char *v = getenv(name);
    return v ? v : fallback;
}

typedef struct {
    ws_server_t *ws;
} scan_pipeline_ctx_t;

/* Entry point for every scanned barcode, whether it came from the real
 * evdev scanner or the /api/debug/scan endpoint. The session/buffer and
 * mono-bin/grammar rules described in README.md are not designed yet, so
 * for now this just logs and pushes the raw scan to WS clients. */
static void handle_scan(const char *barcode, void *user_data) {
    scan_pipeline_ctx_t *ctx = (scan_pipeline_ctx_t *) user_data;
    fprintf(stderr, "scan: %s\n", barcode);

    char *escaped = malloc(strlen(barcode) * 2 + 1);
    size_t j = 0;
    for (size_t i = 0; barcode[i]; i++) {
        if (barcode[i] == '"' || barcode[i] == '\\') {
            escaped[j++] = '\\';
        }
        escaped[j++] = barcode[i];
    }
    escaped[j] = '\0';

    char msg[512];
    snprintf(msg, sizeof(msg), "{\"type\":\"scan\",\"barcode\":\"%s\"}", escaped);
    free(escaped);

    ws_server_broadcast(ctx->ws, msg);
}

int main(void) {
    signal(SIGINT, on_sigterm);
    signal(SIGTERM, on_sigterm);

    const char *db_path = getenv_default("STOREGIZER_DB_PATH", "./data/storegizer.db");
    const char *schema_path = getenv_default("STOREGIZER_SCHEMA_PATH", "./sql/schema.sql");
    int http_port = atoi(getenv_default("HTTP_PORT", "8080"));
    int ws_port = atoi(getenv_default("WS_PORT", "8081"));
    const char *scanner_device = getenv("SCANNER_DEVICE"); /* e.g. /dev/input/event5 */

    db_t db;
    if (db_open(&db, db_path, schema_path) != 0) {
        fprintf(stderr, "main: failed to open database at %s\n", db_path);
        return 1;
    }

    ws_server_t *ws = ws_server_start(ws_port);
    if (!ws) {
        fprintf(stderr, "main: failed to start WS server on port %d\n", ws_port);
        db_close(&db);
        return 1;
    }

    scan_pipeline_ctx_t scan_ctx = {.ws = ws};

    scanner_t *scanner = NULL;
    if (scanner_device) {
        scanner = scanner_evdev_start(scanner_device, handle_scan, &scan_ctx);
        if (!scanner) {
            fprintf(stderr, "main: could not grab scanner device %s, falling back to /api/debug/scan\n", scanner_device);
        }
    } else {
        fprintf(stderr, "main: SCANNER_DEVICE not set, use POST /api/debug/scan to simulate scans\n");
    }

    /* Real hardware not grabbed (dev container, or SCANNER_DEVICE unset)
     * is exactly when the debug endpoint should be available; a live
     * scanner is the single source of truth otherwise. */
    int debug_scan_enabled = scanner == NULL;

    http_server_config_t http_config = {
        .port = http_port,
        .db = &db,
        .debug_scan_cb = debug_scan_enabled ? handle_scan : NULL,
        .debug_scan_user_data = &scan_ctx,
    };

    http_server_t *http = http_server_start(&http_config);
    if (!http) {
        fprintf(stderr, "main: failed to start HTTP server on port %d\n", http_port);
        if (scanner) {
            scanner_evdev_stop(scanner);
        }
        ws_server_stop(ws);
        db_close(&db);
        return 1;
    }

    fprintf(stderr, "main: HTTP on :%d, WS on :%d (debug scan %s)\n",
            http_port, ws_port, debug_scan_enabled ? "enabled" : "disabled");

    while (g_running) {
        sleep(1);
    }

    fprintf(stderr, "main: shutting down\n");
    http_server_stop(http);
    if (scanner) {
        scanner_evdev_stop(scanner);
    }
    ws_server_stop(ws);
    db_close(&db);
    return 0;
}
