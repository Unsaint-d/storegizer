#ifndef STOREGIZER_HTTP_SERVER_H
#define STOREGIZER_HTTP_SERVER_H

#include "../db/db.h"
#include "../grammar/engine.h"

typedef struct http_server http_server_t;

typedef struct {
    int port;
    db_t *db;
    grammar_engine_t *engine;
    /* Whether POST /api/debug/scan is enabled -- used in dev/test setups
     * without a real scanner attached. */
    int debug_scan_enabled;
} http_server_config_t;

http_server_t *http_server_start(const http_server_config_t *config);
void http_server_stop(http_server_t *server);

#endif
