#ifndef STOREGIZER_HTTP_SERVER_H
#define STOREGIZER_HTTP_SERVER_H

#include "../db/db.h"

typedef struct http_server http_server_t;
typedef void (*http_scan_injector_t)(const char *barcode, void *user_data);

typedef struct {
    int port;
    db_t *db;
    /* When non-NULL, POST /api/debug/scan is enabled and forwards its body
     * to this callback -- used in dev/test setups without a real scanner. */
    http_scan_injector_t debug_scan_cb;
    void *debug_scan_user_data;
} http_server_config_t;

http_server_t *http_server_start(const http_server_config_t *config);
void http_server_stop(http_server_t *server);

#endif
