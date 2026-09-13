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

static void add_cors_headers(struct MHD_Response *response) {
    MHD_add_response_header(response, "Access-Control-Allow-Origin", "*");
    MHD_add_response_header(response, "Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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

static char *json_append(char *buf, size_t *len, size_t *cap, const char *piece) {
    size_t piece_len = strlen(piece);
    if (*len + piece_len + 1 > *cap) {
        *cap = (*len + piece_len + 1) * 2;
        buf = realloc(buf, *cap);
    }
    memcpy(buf + *len, piece, piece_len + 1);
    *len += piece_len;
    return buf;
}

/* Hand-rolled, deliberately minimal: finds "key": "string" or "key": 123 in
 * a flat, known-shape JSON object. Not a general parser -- our request
 * bodies never nest or need real unescaping beyond skipping \" . */
static char *json_get_string(const char *body, const char *key) {
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(body, pattern);
    if (!p) {
        return NULL;
    }
    p = strchr(p + strlen(pattern), ':');
    if (!p) {
        return NULL;
    }
    p++;
    while (*p == ' ' || *p == '\t') {
        p++;
    }
    if (*p != '"') {
        return NULL;
    }
    p++;
    const char *end = p;
    while (*end && *end != '"') {
        if (*end == '\\' && *(end + 1)) {
            end++;
        }
        end++;
    }
    size_t len = (size_t) (end - p);
    char *out = malloc(len + 1);
    memcpy(out, p, len);
    out[len] = '\0';
    return out;
}

static long json_get_int(const char *body, const char *key, long fallback) {
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(body, pattern);
    if (!p) {
        return fallback;
    }
    p = strchr(p + strlen(pattern), ':');
    if (!p) {
        return fallback;
    }
    p++;
    char *endptr;
    long value = strtol(p, &endptr, 10);
    if (endptr == p) {
        return fallback;
    }
    return value;
}

/* Parses "key": ["a", "b", ...] -- a flat array of strings, same
 * deliberately-minimal philosophy as json_get_string/json_get_int (no
 * nesting, no general escaping beyond skipping \"). *out_count is 0 and
 * NULL is returned if the key is missing or isn't an array. Caller frees
 * each string and the array itself. */
static char **json_get_string_array(const char *body, const char *key, int *out_count) {
    *out_count = 0;

    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(body, pattern);
    if (!p) {
        return NULL;
    }
    p = strchr(p + strlen(pattern), ':');
    if (!p) {
        return NULL;
    }
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\n') {
        p++;
    }
    if (*p != '[') {
        return NULL;
    }
    p++;

    char **items = NULL;
    int count = 0, cap = 0;

    while (*p) {
        while (*p == ' ' || *p == '\t' || *p == '\n' || *p == ',') {
            p++;
        }
        if (*p == ']' || *p == '\0') {
            break;
        }
        if (*p != '"') {
            break; /* malformed -- stop rather than misparse */
        }
        p++;
        const char *start = p;
        while (*p && *p != '"') {
            if (*p == '\\' && *(p + 1)) {
                p++;
            }
            p++;
        }
        size_t len = (size_t) (p - start);
        char *s = malloc(len + 1);
        memcpy(s, start, len);
        s[len] = '\0';
        if (*p == '"') {
            p++;
        }

        if (count >= cap) {
            cap = cap ? cap * 2 : 4;
            items = realloc(items, (size_t) cap * sizeof(char *));
        }
        items[count++] = s;
    }

    *out_count = count;
    return items;
}

static void free_string_array(char **items, int count) {
    for (int i = 0; i < count; i++) {
        free(items[i]);
    }
    free(items);
}

static int try_parse_id_suffix(const char *url, const char *prefix, int64_t *out_id) {
    size_t prefix_len = strlen(prefix);
    if (strncmp(url, prefix, prefix_len) != 0) {
        return 0;
    }
    const char *rest = url + prefix_len;
    if (*rest == '\0') {
        return 0;
    }
    char *endptr;
    long long id = strtoll(rest, &endptr, 10);
    if (*endptr != '\0' || id <= 0) {
        return 0;
    }
    *out_id = id;
    return 1;
}

/* [1,2,3] -- frontend already has GET /api/tags for names, same pattern as
 * category_id (backend hands over ids, frontend joins). */
static char *item_tag_ids_json(sqlite3 *conn, int64_t item_id) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn, "SELECT tag_id FROM item_tags WHERE item_id = ? ORDER BY tag_id", -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, item_id);

    size_t cap = 64, len = 0;
    char *buf = malloc(cap);
    buf = json_append(buf, &len, &cap, "[");

    int first = 1;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        char entry[24];
        snprintf(entry, sizeof(entry), "%s%lld", first ? "" : ",", (long long) sqlite3_column_int64(stmt, 0));
        buf = json_append(buf, &len, &cap, entry);
        first = 0;
    }

    sqlite3_finalize(stmt);
    buf = json_append(buf, &len, &cap, "]");
    return buf;
}

static char *list_items_json(sqlite3 *conn) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn, "SELECT id, barcode, name, category_id FROM items ORDER BY id", -1, &stmt, NULL);

    size_t cap = 256, len = 0;
    char *buf = malloc(cap);
    buf = json_append(buf, &len, &cap, "[");

    int first = 1;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        int64_t item_id = sqlite3_column_int64(stmt, 0);
        char *barcode = json_escape((const char *) sqlite3_column_text(stmt, 1));
        char *name = json_escape((const char *) sqlite3_column_text(stmt, 2));
        char category_id[32];
        if (sqlite3_column_type(stmt, 3) == SQLITE_NULL) {
            snprintf(category_id, sizeof(category_id), "null");
        } else {
            snprintf(category_id, sizeof(category_id), "%lld", (long long) sqlite3_column_int64(stmt, 3));
        }
        char *tag_ids = item_tag_ids_json(conn, item_id);

        char entry[1152];
        snprintf(entry, sizeof(entry), "%s{\"id\":%lld,\"barcode\":\"%s\",\"name\":\"%s\",\"category_id\":%s,\"tag_ids\":%s}",
                  first ? "" : ",", (long long) item_id, barcode, name, category_id, tag_ids);
        free(barcode);
        free(name);
        free(tag_ids);

        buf = json_append(buf, &len, &cap, entry);
        first = 0;
    }

    sqlite3_finalize(stmt);
    buf = json_append(buf, &len, &cap, "]");
    return buf;
}

static char *list_bins_json(sqlite3 *conn) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn, "SELECT id, barcode, label, kind, mono_item_id FROM bins ORDER BY id", -1, &stmt, NULL);

    size_t cap = 256, len = 0;
    char *buf = malloc(cap);
    buf = json_append(buf, &len, &cap, "[");

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

        buf = json_append(buf, &len, &cap, entry);
        first = 0;
    }

    sqlite3_finalize(stmt);
    buf = json_append(buf, &len, &cap, "]");
    return buf;
}

/* Flat list, id/parent_id/name -- the frontend builds the tree (and any
 * "Крепёж -> Винт -> М2" path strings) client-side rather than have the
 * backend recompute paths per request. */
static char *list_categories_json(sqlite3 *conn) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn, "SELECT id, parent_id, name FROM categories ORDER BY id", -1, &stmt, NULL);

    size_t cap = 256, len = 0;
    char *buf = malloc(cap);
    buf = json_append(buf, &len, &cap, "[");

    int first = 1;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        char *name = json_escape((const char *) sqlite3_column_text(stmt, 2));
        char parent_id[32];
        if (sqlite3_column_type(stmt, 1) == SQLITE_NULL) {
            snprintf(parent_id, sizeof(parent_id), "null");
        } else {
            snprintf(parent_id, sizeof(parent_id), "%lld", (long long) sqlite3_column_int64(stmt, 1));
        }

        char entry[1024];
        snprintf(entry, sizeof(entry), "%s{\"id\":%lld,\"parent_id\":%s,\"name\":\"%s\"}",
                  first ? "" : ",", (long long) sqlite3_column_int64(stmt, 0), parent_id, name);
        free(name);

        buf = json_append(buf, &len, &cap, entry);
        first = 0;
    }

    sqlite3_finalize(stmt);
    buf = json_append(buf, &len, &cap, "]");
    return buf;
}

static char *list_tags_json(sqlite3 *conn) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn, "SELECT id, name, scope_category_id FROM tags ORDER BY name", -1, &stmt, NULL);

    size_t cap = 256, len = 0;
    char *buf = malloc(cap);
    buf = json_append(buf, &len, &cap, "[");

    int first = 1;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        char *name = json_escape((const char *) sqlite3_column_text(stmt, 1));
        char scope[32];
        if (sqlite3_column_type(stmt, 2) == SQLITE_NULL) {
            snprintf(scope, sizeof(scope), "null");
        } else {
            snprintf(scope, sizeof(scope), "%lld", (long long) sqlite3_column_int64(stmt, 2));
        }

        char entry[512];
        snprintf(entry, sizeof(entry), "%s{\"id\":%lld,\"name\":\"%s\",\"scope_category_id\":%s}",
                  first ? "" : ",", (long long) sqlite3_column_int64(stmt, 0), name, scope);
        free(name);

        buf = json_append(buf, &len, &cap, entry);
        first = 0;
    }

    sqlite3_finalize(stmt);
    buf = json_append(buf, &len, &cap, "]");
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

    const char *body = ctx->body ? ctx->body : "";
    enum MHD_Result result;
    int64_t path_id;

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

    } else if (strcmp(method, "GET") == 0 && strcmp(url, "/api/categories") == 0) {
        char *json = list_categories_json(cfg->db->conn);
        result = send_json(connection, 200, json);
        free(json);

    } else if (strcmp(method, "GET") == 0 && strcmp(url, "/api/tags") == 0) {
        char *json = list_tags_json(cfg->db->conn);
        result = send_json(connection, 200, json);
        free(json);

    } else if (strcmp(method, "GET") == 0 && strcmp(url, "/api/settings") == 0) {
        char *json = grammar_engine_settings_json(cfg->engine);
        result = send_json(connection, 200, json);
        free(json);

    } else if (strcmp(method, "PUT") == 0 && strncmp(url, "/api/settings/", strlen("/api/settings/")) == 0 &&
               strlen(url) > strlen("/api/settings/")) {
        const char *key = url + strlen("/api/settings/");
        long value = json_get_int(body, "value", -1);
        if (value <= 0) {
            result = send_json(connection, 400, "{\"error\":\"a positive integer value is required\"}");
        } else if (grammar_engine_update_setting(cfg->engine, key, (int) value) != 0) {
            result = send_json(connection, 400, "{\"error\":\"unknown setting, or failed to persist it\"}");
        } else {
            result = send_json(connection, 200, "{\"status\":\"ok\"}");
        }

    } else if (strcmp(method, "POST") == 0 && strcmp(url, "/api/debug/scan") == 0) {
        if (!cfg->debug_scan_enabled) {
            result = send_json(connection, 403, "{\"error\":\"debug scan disabled (a real scanner is attached)\"}");
        } else {
            char *barcode = ctx->body ? ctx->body : "";
            trim_trailing_whitespace(barcode);
            if (barcode[0] == '\0') {
                result = send_json(connection, 400, "{\"error\":\"empty barcode\"}");
            } else {
                grammar_engine_on_scan(cfg->engine, barcode);
                result = send_json(connection, 200, "{\"status\":\"ok\"}");
            }
        }

    } else if (strcmp(method, "GET") == 0 && strcmp(url, "/api/session") == 0) {
        char *json = grammar_engine_status_json(cfg->engine);
        result = send_json(connection, 200, json);
        free(json);

    } else if (strcmp(method, "POST") == 0 && strcmp(url, "/api/session/open") == 0) {
        result = grammar_engine_open_session(cfg->engine) == 0
                     ? send_json(connection, 200, "{\"status\":\"ok\"}")
                     : send_json(connection, 409, "{\"error\":\"a work session is already open or frozen\"}");

    } else if (strcmp(method, "POST") == 0 && strcmp(url, "/api/session/restore") == 0) {
        result = grammar_engine_restore_session(cfg->engine) == 0
                     ? send_json(connection, 200, "{\"status\":\"ok\"}")
                     : send_json(connection, 409, "{\"error\":\"no frozen session to restore\"}");

    } else if (strcmp(method, "POST") == 0 && strcmp(url, "/api/session/commit") == 0) {
        result = grammar_engine_commit_session(cfg->engine) == 0
                     ? send_json(connection, 200, "{\"status\":\"ok\"}")
                     : send_json(connection, 409, "{\"error\":\"no work session is open\"}");

    } else if (strcmp(method, "POST") == 0 && strcmp(url, "/api/session/rollback") == 0) {
        result = grammar_engine_rollback_session(cfg->engine) == 0
                     ? send_json(connection, 200, "{\"status\":\"ok\"}")
                     : send_json(connection, 409, "{\"error\":\"no work session is open\"}");

    } else if (strcmp(method, "POST") == 0 && strcmp(url, "/api/session/operations") == 0) {
        char *op_type = json_get_string(body, "op_type");
        long item_id = json_get_int(body, "item_id", 0);
        long bin_id = json_get_int(body, "bin_id", 0);
        long quantity = json_get_int(body, "quantity", 0);

        if (!op_type || (strcmp(op_type, "add") != 0 && strcmp(op_type, "remove") != 0) ||
            item_id <= 0 || bin_id <= 0 || quantity <= 0) {
            result = send_json(connection, 400, "{\"error\":\"op_type (add|remove), item_id, bin_id, quantity are required\"}");
        } else {
            int written = grammar_engine_manual_operation(cfg->engine, op_type, item_id, bin_id, (int) quantity);
            if (written < 0) {
                result = send_json(connection, 409, "{\"error\":\"no work session is open\"}");
            } else if (written == 0) {
                result = send_json(connection, 409, "{\"error\":\"not enough stock for this removal\"}");
            } else {
                result = send_json(connection, 200, "{\"status\":\"ok\"}");
            }
        }
        free(op_type);

    } else if (strcmp(method, "DELETE") == 0 && try_parse_id_suffix(url, "/api/session/operations/", &path_id)) {
        result = grammar_engine_delete_operation(cfg->engine, path_id) == 0
                     ? send_json(connection, 200, "{\"status\":\"ok\"}")
                     : send_json(connection, 404, "{\"error\":\"operation not found in the open session\"}");

    } else if (strcmp(method, "PUT") == 0 && try_parse_id_suffix(url, "/api/session/operations/", &path_id)) {
        long quantity = json_get_int(body, "quantity", 0);
        if (quantity <= 0) {
            result = send_json(connection, 400, "{\"error\":\"quantity must be positive\"}");
        } else {
            result = grammar_engine_update_operation_quantity(cfg->engine, path_id, (int) quantity) == 0
                         ? send_json(connection, 200, "{\"status\":\"ok\"}")
                         : send_json(connection, 404, "{\"error\":\"operation not found in the open session\"}");
        }

    } else if (strcmp(method, "POST") == 0 && strcmp(url, "/api/session/items") == 0) {
        /* Creating an item is a session action, same single gate as
         * everything else here -- not a separately-reachable admin
         * surface (docs/scanning-grammar.md §3). Icon upload/editing is
         * separate, later work. */
        char *name = json_get_string(body, "name");
        char *barcode = json_get_string(body, "barcode");
        long category_id = json_get_int(body, "category_id", 0);
        int tag_count = 0;
        char **tag_names = json_get_string_array(body, "tag_names", &tag_count);
        if (!name) {
            result = send_json(connection, 400, "{\"error\":\"name is required\"}");
        } else {
            int64_t id = grammar_engine_create_item(cfg->engine, name, barcode, category_id,
                                                      (const char **) tag_names, tag_count);
            if (id == -1) {
                result = send_json(connection, 409, "{\"error\":\"no work session is open\"}");
            } else if (id == -2) {
                result = send_json(connection, 409, "{\"error\":\"duplicate barcode, invalid category_id, or an empty tag name\"}");
            } else if (id == -3) {
                result = send_json(connection, 409, "{\"error\":\"a named tag is scoped to a category this item isn't in\"}");
            } else {
                char resp[64];
                snprintf(resp, sizeof(resp), "{\"id\":%lld}", (long long) id);
                result = send_json(connection, 200, resp);
            }
        }
        free(name);
        free(barcode);
        free_string_array(tag_names, tag_count);

    } else if (strcmp(method, "POST") == 0 && strcmp(url, "/api/session/tags") == 0) {
        char *name = json_get_string(body, "name");
        long scope_category_id = json_get_int(body, "scope_category_id", 0);
        if (!name) {
            result = send_json(connection, 400, "{\"error\":\"name is required\"}");
        } else {
            int64_t id = grammar_engine_ensure_tag(cfg->engine, name, scope_category_id);
            if (id == -1) {
                result = send_json(connection, 409, "{\"error\":\"no work session is open\"}");
            } else if (id == -2) {
                result = send_json(connection, 400, "{\"error\":\"name must not be empty\"}");
            } else {
                char resp[64];
                snprintf(resp, sizeof(resp), "{\"id\":%lld}", (long long) id);
                result = send_json(connection, 200, resp);
            }
        }
        free(name);

    } else if (strcmp(method, "POST") == 0 && strcmp(url, "/api/session/categories") == 0) {
        int path_len = 0;
        char **path = json_get_string_array(body, "path", &path_len);

        if (path_len == 0) {
            result = send_json(connection, 400, "{\"error\":\"path (non-empty array of names) is required\"}");
        } else {
            int64_t id = grammar_engine_ensure_category_path(cfg->engine, (const char **) path, path_len);
            if (id == -1) {
                result = send_json(connection, 409, "{\"error\":\"no work session is open\"}");
            } else if (id == -2) {
                result = send_json(connection, 400, "{\"error\":\"path segments must be non-empty\"}");
            } else {
                char resp[64];
                snprintf(resp, sizeof(resp), "{\"id\":%lld}", (long long) id);
                result = send_json(connection, 200, resp);
            }
        }
        free_string_array(path, path_len);

    } else if (strcmp(method, "POST") == 0 && strcmp(url, "/api/session/bins") == 0) {
        char *label = json_get_string(body, "label");
        char *kind = json_get_string(body, "kind");
        char *suffix = json_get_string(body, "barcode_suffix");
        long mono_item_id = json_get_int(body, "mono_item_id", 0);

        if (!label || !kind || !suffix || (strcmp(kind, "mono") != 0 && strcmp(kind, "poly") != 0)) {
            result = send_json(connection, 400, "{\"error\":\"label, kind (mono|poly), barcode_suffix are required\"}");
        } else if (strcmp(kind, "mono") == 0 && mono_item_id <= 0) {
            result = send_json(connection, 400, "{\"error\":\"mono_item_id is required for kind=mono\"}");
        } else {
            int64_t id = grammar_engine_create_bin(cfg->engine, label, kind, suffix, mono_item_id);
            if (id == -1) {
                result = send_json(connection, 409, "{\"error\":\"no work session is open\"}");
            } else if (id == -2) {
                result = send_json(connection, 409, "{\"error\":\"barcode already in use\"}");
            } else {
                char resp[192];
                snprintf(resp, sizeof(resp), "{\"id\":%lld,\"barcode\":\"STG-BIN-%s\"}", (long long) id, suffix);
                result = send_json(connection, 200, resp);
            }
        }
        free(label);
        free(kind);
        free(suffix);

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
