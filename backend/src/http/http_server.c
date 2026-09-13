#include "http_server.h"

#include <microhttpd.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct http_server {
    struct MHD_Daemon *daemon;
    http_server_config_t *config;
};

typedef struct {
    char *body;
    size_t body_len;
} request_ctx_t;

/* The web UI is served from a different origin (port) than this API, and
 * per README.md other devices on the LAN reach it that way too -- so every
 * response, including preflights, needs CORS headers. */
static void add_cors_headers(struct MHD_Response *response) {
    MHD_add_response_header(response, "Access-Control-Allow-Origin", "*");
    MHD_add_response_header(response, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    MHD_add_response_header(response, "Access-Control-Allow-Headers", "Content-Type");
}

static enum MHD_Result send_json(struct MHD_Connection *connection, unsigned int status, const char *json) {
    struct MHD_Response *response = MHD_create_response_from_buffer(strlen(json), (void *) json, MHD_RESPMEM_MUST_COPY);
    MHD_add_response_header(response, "Content-Type", "application/json");
    add_cors_headers(response);
    enum MHD_Result ret = MHD_queue_response(connection, status, response);
    MHD_destroy_response(response);
    return ret;
}

/* "..." -> \"...\", good enough for our own barcode/name/label data;
 * not a general-purpose JSON encoder. */
static char *json_escape(const char *s) {
    if (!s) {
        s = "";
    }
    size_t len = strlen(s);
    char *out = malloc(len * 2 + 1);
    size_t j = 0;
    for (size_t i = 0; i < len; i++) {
        if (s[i] == '"' || s[i] == '\\') {
            out[j++] = '\\';
        }
        out[j++] = s[i];
    }
    out[j] = '\0';
    return out;
}

static char *append(char *buf, size_t *len, size_t *cap, const char *piece) {
    size_t piece_len = strlen(piece);
    if (*len + piece_len + 1 > *cap) {
        *cap = (*len + piece_len + 1) * 2;
        buf = realloc(buf, *cap);
    }
    memcpy(buf + *len, piece, piece_len + 1);
    *len += piece_len;
    return buf;
}

static char *list_items_json(sqlite3 *conn) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn, "SELECT id, barcode, name FROM items ORDER BY id", -1, &stmt, NULL);

    size_t cap = 256, len = 0;
    char *buf = malloc(cap);
    buf = append(buf, &len, &cap, "[");

    int first = 1;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        char *barcode = json_escape((const char *) sqlite3_column_text(stmt, 1));
        char *name = json_escape((const char *) sqlite3_column_text(stmt, 2));

        char entry[1024];
        snprintf(entry, sizeof(entry), "%s{\"id\":%lld,\"barcode\":\"%s\",\"name\":\"%s\"}",
                  first ? "" : ",", (long long) sqlite3_column_int64(stmt, 0), barcode, name);
        free(barcode);
        free(name);

        buf = append(buf, &len, &cap, entry);
        first = 0;
    }

    sqlite3_finalize(stmt);
    buf = append(buf, &len, &cap, "]");
    return buf;
}

static char *list_bins_json(sqlite3 *conn) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn, "SELECT id, barcode, label, kind, mono_item_id FROM bins ORDER BY id", -1, &stmt, NULL);

    size_t cap = 256, len = 0;
    char *buf = malloc(cap);
    buf = append(buf, &len, &cap, "[");

    int first = 1;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        char *barcode = json_escape((const char *) sqlite3_column_text(stmt, 1));
        char *label = json_escape((const char *) sqlite3_column_text(stmt, 2));
        char *kind = json_escape((const char *) sqlite3_column_text(stmt, 3));

        char mono_item_id[32];
        if (sqlite3_column_type(stmt, 4) == SQLITE_NULL) {
            snprintf(mono_item_id, sizeof(mono_item_id), "null");
        } else {
            snprintf(mono_item_id, sizeof(mono_item_id), "%lld", (long long) sqlite3_column_int64(stmt, 4));
        }

        char entry[1024];
        snprintf(entry, sizeof(entry), "%s{\"id\":%lld,\"barcode\":\"%s\",\"label\":\"%s\",\"kind\":\"%s\",\"mono_item_id\":%s}",
                  first ? "" : ",", (long long) sqlite3_column_int64(stmt, 0), barcode, label, kind, mono_item_id);
        free(barcode);
        free(label);
        free(kind);

        buf = append(buf, &len, &cap, entry);
        first = 0;
    }

    sqlite3_finalize(stmt);
    buf = append(buf, &len, &cap, "]");
    return buf;
}

static void trim_trailing_whitespace(char *s) {
    size_t n = strlen(s);
    while (n > 0 && (s[n - 1] == '\n' || s[n - 1] == '\r' || s[n - 1] == ' ' || s[n - 1] == '\t')) {
        s[--n] = '\0';
    }
}

static enum MHD_Result handle_request(void *cls, struct MHD_Connection *connection,
                                       const char *url, const char *method,
                                       const char *version, const char *upload_data,
                                       size_t *upload_data_size, void **con_cls) {
    (void) version;
    http_server_config_t *cfg = (http_server_config_t *) cls;

    if (*con_cls == NULL) {
        *con_cls = calloc(1, sizeof(request_ctx_t));
        return MHD_YES;
    }

    request_ctx_t *ctx = (request_ctx_t *) *con_cls;

    if (*upload_data_size > 0) {
        ctx->body = realloc(ctx->body, ctx->body_len + *upload_data_size + 1);
        memcpy(ctx->body + ctx->body_len, upload_data, *upload_data_size);
        ctx->body_len += *upload_data_size;
        ctx->body[ctx->body_len] = '\0';
        *upload_data_size = 0;
        return MHD_YES;
    }

    enum MHD_Result result;

    if (strcmp(method, "OPTIONS") == 0) {
        struct MHD_Response *response = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
        add_cors_headers(response);
        result = MHD_queue_response(connection, 204, response);
        MHD_destroy_response(response);
    } else if (strcmp(method, "GET") == 0 && strcmp(url, "/api/health") == 0) {
        result = send_json(connection, 200, "{\"status\":\"ok\"}");
    } else if (strcmp(method, "GET") == 0 && strcmp(url, "/api/items") == 0) {
        char *json = list_items_json(cfg->db->conn);
        result = send_json(connection, 200, json);
        free(json);
    } else if (strcmp(method, "GET") == 0 && strcmp(url, "/api/bins") == 0) {
        char *json = list_bins_json(cfg->db->conn);
        result = send_json(connection, 200, json);
        free(json);
    } else if (strcmp(method, "POST") == 0 && strcmp(url, "/api/debug/scan") == 0) {
        if (!cfg->debug_scan_cb) {
            result = send_json(connection, 403, "{\"error\":\"debug scan disabled (a real scanner is attached)\"}");
        } else {
            char *barcode = ctx->body ? ctx->body : "";
            trim_trailing_whitespace(barcode);
            if (barcode[0] == '\0') {
                result = send_json(connection, 400, "{\"error\":\"empty barcode\"}");
            } else {
                cfg->debug_scan_cb(barcode, cfg->debug_scan_user_data);
                result = send_json(connection, 200, "{\"status\":\"ok\"}");
            }
        }
    } else {
        result = send_json(connection, 404, "{\"error\":\"not found\"}");
    }

    free(ctx->body);
    free(ctx);
    *con_cls = NULL;
    return result;
}

http_server_t *http_server_start(const http_server_config_t *config) {
    http_server_t *server = malloc(sizeof(http_server_t));
    server->config = malloc(sizeof(http_server_config_t));
    *server->config = *config;

    server->daemon = MHD_start_daemon(MHD_USE_INTERNAL_POLLING_THREAD,
                                       (uint16_t) config->port, NULL, NULL,
                                       &handle_request, server->config,
                                       MHD_OPTION_END);
    if (!server->daemon) {
        free(server->config);
        free(server);
        return NULL;
    }

    return server;
}

void http_server_stop(http_server_t *server) {
    if (!server) {
        return;
    }
    MHD_stop_daemon(server->daemon);
    free(server->config);
    free(server);
}
