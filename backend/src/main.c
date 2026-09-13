#include "db/db.h"
#include "grammar/engine.h"
#include "http/http_server.h"
#include "scanner/scanner.h"
#include "ws/ws_server.h"

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
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

/* Adapts scanner_scan_cb's (barcode, user_data) shape to the engine's own
 * (engine, barcode) -- same entry point the /api/debug/scan endpoint uses,
 * so real and simulated scans go through identical grammar handling. */
static void on_real_scan(const char *barcode, void *user_data) {
    grammar_engine_on_scan((grammar_engine_t *) user_data, barcode);
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

    grammar_engine_t *engine = grammar_engine_create(&db, ws);

    scanner_t *scanner = NULL;
    if (scanner_device) {
        scanner = scanner_evdev_start(scanner_device, on_real_scan, engine);
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
        .engine = engine,
        .debug_scan_enabled = debug_scan_enabled,
    };

    http_server_t *http = http_server_start(&http_config);
    if (!http) {
        fprintf(stderr, "main: failed to start HTTP server on port %d\n", http_port);
        if (scanner) {
            scanner_evdev_stop(scanner);
        }
        grammar_engine_destroy(engine);
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
    grammar_engine_destroy(engine);
    ws_server_stop(ws);
    db_close(&db);
    return 0;
}
