#include "engine.h"
#include "classify.h"

#include <pthread.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define WORK_SESSION_IDLE_SECONDS (10 * 60)

typedef struct pending_item {
    int64_t item_id;
    int64_t via_pack_item_id; /* 0 if not the result of pack expansion */
    int quantity;
    struct pending_item *next;
} pending_item_t;

typedef struct bin_session {
    int64_t bin_id;
    char op_type[8]; /* "add" or "remove" */
    time_t last_item_at;
    pending_item_t *items;
    struct bin_session *next;
} bin_session_t;

struct grammar_engine {
    db_t *db;
    ws_server_t *ws;

    pthread_mutex_t lock;
    pthread_t ticker_thread;
    volatile int stop_flag;

    int64_t work_session_id; /* 0 = none open or frozen */
    char work_session_status[16]; /* "open" | "frozen" */
    time_t last_activity_at;

    int64_t focused_bin_id; /* 0 = no focus */
    bin_session_t *bin_sessions;
    pending_item_t *unassigned_items; /* items scanned with no bin focused yet */
};

/* ---- small helpers ---- */

static void free_pending_list(pending_item_t *list) {
    while (list) {
        pending_item_t *next = list->next;
        free(list);
        list = next;
    }
}

static void accumulate_into(pending_item_t **head, int64_t item_id, int64_t via_pack_item_id, int quantity) {
    for (pending_item_t *p = *head; p; p = p->next) {
        if (p->item_id == item_id && p->via_pack_item_id == via_pack_item_id) {
            p->quantity += quantity;
            return;
        }
    }
    pending_item_t *p = malloc(sizeof(pending_item_t));
    p->item_id = item_id;
    p->via_pack_item_id = via_pack_item_id;
    p->quantity = quantity;
    p->next = *head;
    *head = p;
}

static bin_session_t *find_bin_session(grammar_engine_t *e, int64_t bin_id) {
    for (bin_session_t *bs = e->bin_sessions; bs; bs = bs->next) {
        if (bs->bin_id == bin_id) {
            return bs;
        }
    }
    return NULL;
}

/* ---- DB helpers ---- */

static int64_t find_bin_by_barcode(db_t *db, const char *barcode) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db->conn, "SELECT id FROM bins WHERE barcode = ?", -1, &stmt, NULL);
    sqlite3_bind_text(stmt, 1, barcode, -1, SQLITE_TRANSIENT);
    int64_t id = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        id = sqlite3_column_int64(stmt, 0);
    }
    sqlite3_finalize(stmt);
    return id;
}

static int64_t find_item_by_barcode(db_t *db, const char *barcode) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db->conn, "SELECT id FROM items WHERE barcode = ?", -1, &stmt, NULL);
    sqlite3_bind_text(stmt, 1, barcode, -1, SQLITE_TRANSIENT);
    int64_t id = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        id = sqlite3_column_int64(stmt, 0);
    }
    sqlite3_finalize(stmt);
    return id;
}

/* Tagged with the work session that caused it to exist, same as bin/item
 * creation from the panel -- if that session gets rolled back, this item
 * (which only exists because of it) is discarded too, not left behind. */
static int64_t create_item_with_barcode(db_t *db, const char *barcode, int64_t work_session_id) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db->conn, "INSERT INTO items (barcode, name, created_in_work_session_id) VALUES (?, ?, ?)", -1, &stmt, NULL);
    sqlite3_bind_text(stmt, 1, barcode, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, "", -1, SQLITE_STATIC);
    sqlite3_bind_int64(stmt, 3, work_session_id);
    sqlite3_step(stmt);
    int64_t id = sqlite3_last_insert_rowid(db->conn);
    sqlite3_finalize(stmt);
    fprintf(stderr, "grammar: new item #%lld created for unknown barcode %s\n", (long long) id, barcode);
    return id;
}

static int get_setting_int(db_t *db, const char *key, int fallback) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db->conn, "SELECT value FROM settings WHERE key = ?", -1, &stmt, NULL);
    sqlite3_bind_text(stmt, 1, key, -1, SQLITE_STATIC);
    int value = fallback;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        value = atoi((const char *) sqlite3_column_text(stmt, 0));
    }
    sqlite3_finalize(stmt);
    return value;
}

static int get_bin_stock_quantity(db_t *db, int64_t bin_id, int64_t item_id) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db->conn, "SELECT quantity FROM bin_stock WHERE bin_id = ? AND item_id = ?", -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, bin_id);
    sqlite3_bind_int64(stmt, 2, item_id);
    int qty = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        qty = sqlite3_column_int(stmt, 0);
    }
    sqlite3_finalize(stmt);
    return qty;
}

static int get_buffered_removed_sum(db_t *db, int64_t work_session_id, int64_t bin_id, int64_t item_id) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db->conn,
                        "SELECT COALESCE(SUM(quantity), 0) FROM buffered_operations "
                        "WHERE work_session_id = ? AND bin_id = ? AND item_id = ? AND op_type = 'remove'",
                        -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, work_session_id);
    sqlite3_bind_int64(stmt, 2, bin_id);
    sqlite3_bind_int64(stmt, 3, item_id);
    int sum = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        sum = sqlite3_column_int(stmt, 0);
    }
    sqlite3_finalize(stmt);
    return sum;
}

/* Expands item_id through item_pack_contents (single level -- no
 * pack-of-packs, see docs/scanning-grammar.md §2) into the list of what
 * actually gets buffered. Items with no pack contents pass through as a
 * single entry with via_pack_item_id = 0. */
static void expand_item(db_t *db, int64_t item_id, int quantity, pending_item_t **out) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db->conn, "SELECT child_item_id, quantity FROM item_pack_contents WHERE pack_item_id = ?", -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, item_id);

    int had_contents = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        had_contents = 1;
        int64_t child_item_id = sqlite3_column_int64(stmt, 0);
        int per_pack = sqlite3_column_int(stmt, 1);
        accumulate_into(out, child_item_id, item_id, per_pack * quantity);
    }
    sqlite3_finalize(stmt);

    if (!had_contents) {
        accumulate_into(out, item_id, 0, quantity);
    }
}

static int64_t insert_buffered_operation(db_t *db, int64_t work_session_id, const char *op_type,
                                          int64_t item_id, int64_t bin_id, int quantity,
                                          const char *source, int64_t via_pack_item_id) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db->conn,
                        "INSERT INTO buffered_operations "
                        "(work_session_id, op_type, item_id, bin_id, quantity, source, via_pack_item_id, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, work_session_id);
    sqlite3_bind_text(stmt, 2, op_type, -1, SQLITE_STATIC);
    sqlite3_bind_int64(stmt, 3, item_id);
    sqlite3_bind_int64(stmt, 4, bin_id);
    sqlite3_bind_int(stmt, 5, quantity);
    sqlite3_bind_text(stmt, 6, source, -1, SQLITE_STATIC);
    if (via_pack_item_id != 0) {
        sqlite3_bind_int64(stmt, 7, via_pack_item_id);
    } else {
        sqlite3_bind_null(stmt, 7);
    }
    sqlite3_bind_int64(stmt, 8, (sqlite3_int64) time(NULL));
    sqlite3_step(stmt);
    int64_t id = sqlite3_last_insert_rowid(db->conn);
    sqlite3_finalize(stmt);
    return id;
}

/* ---- session/focus state machine ---- */

static void broadcast_buffer_changed(grammar_engine_t *e) {
    ws_server_broadcast(e->ws, "{\"type\":\"buffer_changed\"}");
}

static void broadcast_error(grammar_engine_t *e, const char *message) {
    char buf[256];
    snprintf(buf, sizeof(buf), "{\"type\":\"error\",\"message\":\"%s\"}", message);
    /* TODO(docs/scanning-grammar.md §4.3): this should target only the WS
     * connection holding the active work session, not every client. There
     * is no addressable per-session channel yet -- everyone connected
     * currently hears every error. */
    ws_server_broadcast(e->ws, buf);
}

/* Writes a bin-session's accumulated items to buffered_operations and
 * removes it from the engine, clearing focus if it was the focused one.
 * No-op if bin_id has no open session. */
static void close_bin_session(grammar_engine_t *e, int64_t bin_id) {
    bin_session_t **pp = &e->bin_sessions;
    while (*pp && (*pp)->bin_id != bin_id) {
        pp = &(*pp)->next;
    }
    if (!*pp) {
        return;
    }

    bin_session_t *bs = *pp;
    *pp = bs->next;

    for (pending_item_t *p = bs->items; p; p = p->next) {
        insert_buffered_operation(e->db, e->work_session_id, bs->op_type, p->item_id, bin_id, p->quantity,
                                   "scan", p->via_pack_item_id);
    }

    free_pending_list(bs->items);
    free(bs);

    if (e->focused_bin_id == bin_id) {
        e->focused_bin_id = 0;
    }
}

static void handle_bin_scan(grammar_engine_t *e, int64_t bin_id) {
    if (e->focused_bin_id == bin_id) {
        close_bin_session(e, bin_id);
        broadcast_buffer_changed(e);
        return;
    }

    if (!find_bin_session(e, bin_id)) {
        bin_session_t *bs = calloc(1, sizeof(bin_session_t));
        bs->bin_id = bin_id;
        bs->last_item_at = time(NULL);
        if (e->unassigned_items) {
            strcpy(bs->op_type, "add");
            bs->items = e->unassigned_items;
            e->unassigned_items = NULL;
        } else {
            strcpy(bs->op_type, "remove");
        }
        bs->next = e->bin_sessions;
        e->bin_sessions = bs;
    }
    e->focused_bin_id = bin_id;
    broadcast_buffer_changed(e);
}

static void handle_item_scan(grammar_engine_t *e, int64_t item_id) {
    if (e->focused_bin_id == 0) {
        expand_item(e->db, item_id, 1, &e->unassigned_items);
        broadcast_buffer_changed(e);
        return;
    }

    bin_session_t *bs = find_bin_session(e, e->focused_bin_id);
    if (!bs) {
        /* defensive: focus without a session shouldn't happen */
        e->focused_bin_id = 0;
        return;
    }

    if (strcmp(bs->op_type, "remove") == 0) {
        pending_item_t *expanded = NULL;
        expand_item(e->db, item_id, 1, &expanded);

        for (pending_item_t *p = expanded; p; p = p->next) {
            int stock = get_bin_stock_quantity(e->db, bs->bin_id, p->item_id);
            int already_buffered = get_buffered_removed_sum(e->db, e->work_session_id, bs->bin_id, p->item_id);
            int already_live = 0;
            for (pending_item_t *q = bs->items; q; q = q->next) {
                if (q->item_id == p->item_id) {
                    already_live += q->quantity;
                }
            }
            int available = stock - already_buffered - already_live;
            if (available < p->quantity) {
                fprintf(stderr, "grammar: over-removal blocked (item #%lld, bin #%lld, available %d, wanted %d)\n",
                        (long long) p->item_id, (long long) bs->bin_id, available, p->quantity);
                broadcast_error(e, "Недостаточно предметов в ячейке");
                free_pending_list(expanded);
                return;
            }
        }

        for (pending_item_t *p = expanded; p; p = p->next) {
            accumulate_into(&bs->items, p->item_id, p->via_pack_item_id, p->quantity);
        }
        free_pending_list(expanded);
    } else {
        expand_item(e->db, item_id, 1, &bs->items);
    }

    bs->last_item_at = time(NULL);
    broadcast_buffer_changed(e);
}

static void *ticker_thread_fn(void *arg) {
    grammar_engine_t *e = arg;

    while (!e->stop_flag) {
        sleep(1);
        pthread_mutex_lock(&e->lock);

        if (e->work_session_id != 0 && strcmp(e->work_session_status, "open") == 0) {
            int timeout = get_setting_int(e->db, "scan_op_timeout_seconds", 10);
            time_t now = time(NULL);

            int closed_any = 0;
            int again = 1;
            while (again) {
                again = 0;
                for (bin_session_t *bs = e->bin_sessions; bs; bs = bs->next) {
                    if (strcmp(bs->op_type, "remove") == 0 && now - bs->last_item_at >= timeout) {
                        close_bin_session(e, bs->bin_id);
                        closed_any = 1;
                        again = 1;
                        break; /* list mutated, restart the scan */
                    }
                }
            }
            if (closed_any) {
                broadcast_buffer_changed(e);
            }

            if (now - e->last_activity_at >= WORK_SESSION_IDLE_SECONDS) {
                sqlite3_stmt *stmt;
                sqlite3_prepare_v2(e->db->conn, "UPDATE work_sessions SET status = 'frozen', frozen_at = ? WHERE id = ?",
                                    -1, &stmt, NULL);
                sqlite3_bind_int64(stmt, 1, (sqlite3_int64) now);
                sqlite3_bind_int64(stmt, 2, e->work_session_id);
                sqlite3_step(stmt);
                sqlite3_finalize(stmt);
                strcpy(e->work_session_status, "frozen");
                fprintf(stderr, "grammar: work session #%lld frozen after %ds idle\n",
                        (long long) e->work_session_id, WORK_SESSION_IDLE_SECONDS);
                broadcast_buffer_changed(e);
            }
        }

        pthread_mutex_unlock(&e->lock);
    }

    return NULL;
}

/* ---- public API ---- */

grammar_engine_t *grammar_engine_create(db_t *db, ws_server_t *ws) {
    grammar_engine_t *e = calloc(1, sizeof(grammar_engine_t));
    e->db = db;
    e->ws = ws;
    pthread_mutex_init(&e->lock, NULL);

    /* Pick up a session left open/frozen by a previous (possibly crashed)
     * run -- the buffer is durable, so this is just re-attaching, not
     * recovering anything. */
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db->conn, "SELECT id, status FROM work_sessions WHERE status IN ('open', 'frozen')", -1, &stmt, NULL);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        e->work_session_id = sqlite3_column_int64(stmt, 0);
        strncpy(e->work_session_status, (const char *) sqlite3_column_text(stmt, 1), sizeof(e->work_session_status) - 1);
    }
    sqlite3_finalize(stmt);
    e->last_activity_at = time(NULL);

    pthread_create(&e->ticker_thread, NULL, ticker_thread_fn, e);
    return e;
}

void grammar_engine_destroy(grammar_engine_t *e) {
    if (!e) {
        return;
    }
    e->stop_flag = 1;
    pthread_join(e->ticker_thread, NULL);

    while (e->bin_sessions) {
        bin_session_t *bs = e->bin_sessions;
        e->bin_sessions = bs->next;
        free_pending_list(bs->items);
        free(bs);
    }
    free_pending_list(e->unassigned_items);
    pthread_mutex_destroy(&e->lock);
    free(e);
}

void grammar_engine_on_scan(grammar_engine_t *e, const char *raw_code) {
    pthread_mutex_lock(&e->lock);

    if (e->work_session_id == 0 || strcmp(e->work_session_status, "open") != 0) {
        fprintf(stderr, "grammar: scan ignored, no open work session: %s\n", raw_code);
        pthread_mutex_unlock(&e->lock);
        return;
    }

    e->last_activity_at = time(NULL);

    code_kind_t kind = classify_code(raw_code);
    if (kind == CODE_KIND_BIN) {
        int64_t bin_id = find_bin_by_barcode(e->db, raw_code);
        if (bin_id == 0) {
            fprintf(stderr, "grammar: unknown bin code (bins can't be auto-created): %s\n", raw_code);
            broadcast_error(e, "Неизвестная ячейка");
            pthread_mutex_unlock(&e->lock);
            return;
        }
        handle_bin_scan(e, bin_id);
    } else {
        int64_t item_id = find_item_by_barcode(e->db, raw_code);
        if (item_id == 0) {
            item_id = create_item_with_barcode(e->db, raw_code, e->work_session_id);
        }
        handle_item_scan(e, item_id);
    }

    pthread_mutex_unlock(&e->lock);
}

int grammar_engine_open_session(grammar_engine_t *e) {
    pthread_mutex_lock(&e->lock);
    if (e->work_session_id != 0) {
        pthread_mutex_unlock(&e->lock);
        return -1;
    }

    /* TODO(README open question #3): gate this behind admin authentication
     * once a scheme is chosen. Anyone reaching the HTTP API can open a
     * session today. */
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(e->db->conn, "INSERT INTO work_sessions (status, opened_at) VALUES ('open', ?)", -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, (sqlite3_int64) time(NULL));
    int rc = sqlite3_step(stmt);
    int64_t id = sqlite3_last_insert_rowid(e->db->conn);
    sqlite3_finalize(stmt);

    if (rc != SQLITE_DONE) {
        pthread_mutex_unlock(&e->lock);
        return -1;
    }

    e->work_session_id = id;
    strcpy(e->work_session_status, "open");
    e->last_activity_at = time(NULL);
    pthread_mutex_unlock(&e->lock);
    broadcast_buffer_changed(e);
    return 0;
}

int grammar_engine_restore_session(grammar_engine_t *e) {
    pthread_mutex_lock(&e->lock);
    if (e->work_session_id == 0 || strcmp(e->work_session_status, "frozen") != 0) {
        pthread_mutex_unlock(&e->lock);
        return -1;
    }

    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(e->db->conn, "UPDATE work_sessions SET status = 'open', frozen_at = NULL WHERE id = ?", -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, e->work_session_id);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    strcpy(e->work_session_status, "open");
    e->last_activity_at = time(NULL);
    pthread_mutex_unlock(&e->lock);
    broadcast_buffer_changed(e);
    return 0;
}

int grammar_engine_commit_session(grammar_engine_t *e) {
    pthread_mutex_lock(&e->lock);
    if (e->work_session_id == 0) {
        pthread_mutex_unlock(&e->lock);
        return -1;
    }

    /* Fold any still-open bin-sessions into the buffer as-is; there is
     * nothing left "in flight" to lose by committing. */
    while (e->bin_sessions) {
        close_bin_session(e, e->bin_sessions->bin_id);
    }
    free_pending_list(e->unassigned_items);
    e->unassigned_items = NULL;

    int64_t session_id = e->work_session_id;

    sqlite3_exec(e->db->conn, "BEGIN", NULL, NULL, NULL);

    sqlite3_stmt *sel;
    sqlite3_prepare_v2(e->db->conn,
                        "SELECT op_type, item_id, bin_id, quantity, via_pack_item_id FROM buffered_operations WHERE work_session_id = ?",
                        -1, &sel, NULL);
    sqlite3_bind_int64(sel, 1, session_id);

    sqlite3_stmt *upsert;
    sqlite3_prepare_v2(e->db->conn,
                        "INSERT INTO bin_stock (bin_id, item_id, quantity) VALUES (?, ?, ?) "
                        "ON CONFLICT (bin_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity",
                        -1, &upsert, NULL);

    sqlite3_stmt *audit;
    sqlite3_prepare_v2(e->db->conn,
                        "INSERT INTO audit_log (ts, op_type, item_id, bin_id, quantity, via_pack_item_id) VALUES (?, ?, ?, ?, ?, ?)",
                        -1, &audit, NULL);

    time_t now = time(NULL);
    while (sqlite3_step(sel) == SQLITE_ROW) {
        const char *op_type = (const char *) sqlite3_column_text(sel, 0);
        int64_t item_id = sqlite3_column_int64(sel, 1);
        int64_t bin_id = sqlite3_column_int64(sel, 2);
        int quantity = sqlite3_column_int(sel, 3);
        int has_pack = sqlite3_column_type(sel, 4) != SQLITE_NULL;
        int64_t via_pack_item_id = has_pack ? sqlite3_column_int64(sel, 4) : 0;

        int signed_qty = (strcmp(op_type, "remove") == 0) ? -quantity : quantity;

        sqlite3_reset(upsert);
        sqlite3_bind_int64(upsert, 1, bin_id);
        sqlite3_bind_int64(upsert, 2, item_id);
        sqlite3_bind_int(upsert, 3, signed_qty);
        sqlite3_step(upsert);

        sqlite3_reset(audit);
        sqlite3_bind_int64(audit, 1, (sqlite3_int64) now);
        sqlite3_bind_text(audit, 2, op_type, -1, SQLITE_STATIC);
        sqlite3_bind_int64(audit, 3, item_id);
        sqlite3_bind_int64(audit, 4, bin_id);
        sqlite3_bind_int(audit, 5, quantity);
        if (has_pack) {
            sqlite3_bind_int64(audit, 6, via_pack_item_id);
        } else {
            sqlite3_bind_null(audit, 6);
        }
        sqlite3_step(audit);
    }

    sqlite3_finalize(sel);
    sqlite3_finalize(upsert);
    sqlite3_finalize(audit);

    sqlite3_stmt *close_stmt;
    sqlite3_prepare_v2(e->db->conn, "UPDATE work_sessions SET status = 'committed', closed_at = ? WHERE id = ?", -1, &close_stmt, NULL);
    sqlite3_bind_int64(close_stmt, 1, (sqlite3_int64) now);
    sqlite3_bind_int64(close_stmt, 2, session_id);
    sqlite3_step(close_stmt);
    sqlite3_finalize(close_stmt);

    sqlite3_exec(e->db->conn, "COMMIT", NULL, NULL, NULL);

    e->work_session_id = 0;
    e->work_session_status[0] = '\0';
    e->focused_bin_id = 0;

    pthread_mutex_unlock(&e->lock);
    broadcast_buffer_changed(e);
    return 0;
}

int grammar_engine_rollback_session(grammar_engine_t *e) {
    pthread_mutex_lock(&e->lock);
    if (e->work_session_id == 0) {
        pthread_mutex_unlock(&e->lock);
        return -1;
    }

    /* Discard anything still in flight without ever buffering it -- unlike
     * commit, rollback throws away in-progress bin-sessions too. */
    while (e->bin_sessions) {
        bin_session_t *bs = e->bin_sessions;
        e->bin_sessions = bs->next;
        free_pending_list(bs->items);
        free(bs);
    }
    free_pending_list(e->unassigned_items);
    e->unassigned_items = NULL;

    /* Full undo, not just "don't apply": already-buffered operations from
     * closed bin-sessions earlier in this session are deleted too, along
     * with any bin/item created from the panel or auto-created for an
     * unrecognized item barcode while this session was open -- none of it
     * would exist if not for this session. Order matters for foreign keys:
     * buffered_operations (references bins/items) before bins (references
     * items via mono_item_id) before items. */
    sqlite3_exec(e->db->conn, "BEGIN", NULL, NULL, NULL);

    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(e->db->conn, "DELETE FROM buffered_operations WHERE work_session_id = ?", -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, e->work_session_id);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    sqlite3_prepare_v2(e->db->conn, "DELETE FROM bins WHERE created_in_work_session_id = ?", -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, e->work_session_id);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    sqlite3_prepare_v2(e->db->conn, "DELETE FROM items WHERE created_in_work_session_id = ?", -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, e->work_session_id);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    sqlite3_prepare_v2(e->db->conn, "UPDATE work_sessions SET status = 'rolled_back', closed_at = ? WHERE id = ?", -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, (sqlite3_int64) time(NULL));
    sqlite3_bind_int64(stmt, 2, e->work_session_id);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    sqlite3_exec(e->db->conn, "COMMIT", NULL, NULL, NULL);

    e->work_session_id = 0;
    e->work_session_status[0] = '\0';
    e->focused_bin_id = 0;

    pthread_mutex_unlock(&e->lock);
    broadcast_buffer_changed(e);
    return 0;
}

int grammar_engine_manual_operation(grammar_engine_t *e, const char *op_type, int64_t item_id, int64_t bin_id, int quantity) {
    pthread_mutex_lock(&e->lock);
    if (e->work_session_id == 0 || strcmp(e->work_session_status, "open") != 0) {
        pthread_mutex_unlock(&e->lock);
        return -1;
    }

    pending_item_t *expanded = NULL;
    expand_item(e->db, item_id, quantity, &expanded);

    if (strcmp(op_type, "remove") == 0) {
        for (pending_item_t *p = expanded; p; p = p->next) {
            int stock = get_bin_stock_quantity(e->db, bin_id, p->item_id);
            int already_buffered = get_buffered_removed_sum(e->db, e->work_session_id, bin_id, p->item_id);
            if (stock - already_buffered < p->quantity) {
                broadcast_error(e, "Недостаточно предметов в ячейке");
                free_pending_list(expanded);
                pthread_mutex_unlock(&e->lock);
                return 0;
            }
        }
    }

    int written = 0;
    for (pending_item_t *p = expanded; p; p = p->next) {
        insert_buffered_operation(e->db, e->work_session_id, op_type, p->item_id, bin_id, p->quantity, "manual", p->via_pack_item_id);
        written++;
    }
    free_pending_list(expanded);

    e->last_activity_at = time(NULL);
    pthread_mutex_unlock(&e->lock);
    broadcast_buffer_changed(e);
    return written;
}

int grammar_engine_delete_operation(grammar_engine_t *e, int64_t operation_id) {
    pthread_mutex_lock(&e->lock);
    if (e->work_session_id == 0) {
        pthread_mutex_unlock(&e->lock);
        return -1;
    }

    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(e->db->conn, "DELETE FROM buffered_operations WHERE id = ? AND work_session_id = ?", -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, operation_id);
    sqlite3_bind_int64(stmt, 2, e->work_session_id);
    sqlite3_step(stmt);
    int changed = sqlite3_changes(e->db->conn);
    sqlite3_finalize(stmt);

    pthread_mutex_unlock(&e->lock);
    if (changed > 0) {
        broadcast_buffer_changed(e);
        return 0;
    }
    return -1;
}

int grammar_engine_update_operation_quantity(grammar_engine_t *e, int64_t operation_id, int quantity) {
    pthread_mutex_lock(&e->lock);
    if (e->work_session_id == 0 || quantity <= 0) {
        pthread_mutex_unlock(&e->lock);
        return -1;
    }

    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(e->db->conn, "UPDATE buffered_operations SET quantity = ? WHERE id = ? AND work_session_id = ?", -1, &stmt, NULL);
    sqlite3_bind_int(stmt, 1, quantity);
    sqlite3_bind_int64(stmt, 2, operation_id);
    sqlite3_bind_int64(stmt, 3, e->work_session_id);
    sqlite3_step(stmt);
    int changed = sqlite3_changes(e->db->conn);
    sqlite3_finalize(stmt);

    pthread_mutex_unlock(&e->lock);
    if (changed > 0) {
        broadcast_buffer_changed(e);
        return 0;
    }
    return -1;
}

int64_t grammar_engine_create_item(grammar_engine_t *e, const char *name, const char *barcode) {
    pthread_mutex_lock(&e->lock);
    if (e->work_session_id == 0 || strcmp(e->work_session_status, "open") != 0) {
        pthread_mutex_unlock(&e->lock);
        return -1;
    }

    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(e->db->conn, "INSERT INTO items (barcode, name, created_in_work_session_id) VALUES (?, ?, ?)", -1, &stmt, NULL);
    if (barcode && barcode[0] != '\0') {
        sqlite3_bind_text(stmt, 1, barcode, -1, SQLITE_TRANSIENT);
    } else {
        sqlite3_bind_null(stmt, 1);
    }
    sqlite3_bind_text(stmt, 2, name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 3, e->work_session_id);
    int rc = sqlite3_step(stmt);
    int64_t id = sqlite3_last_insert_rowid(e->db->conn);
    sqlite3_finalize(stmt);

    e->last_activity_at = time(NULL);
    pthread_mutex_unlock(&e->lock);

    if (rc != SQLITE_DONE) {
        return -2;
    }
    broadcast_buffer_changed(e);
    return id;
}

int64_t grammar_engine_create_bin(grammar_engine_t *e, const char *label, const char *kind,
                                   const char *barcode_suffix, int64_t mono_item_id) {
    pthread_mutex_lock(&e->lock);
    if (e->work_session_id == 0 || strcmp(e->work_session_status, "open") != 0) {
        pthread_mutex_unlock(&e->lock);
        return -1;
    }

    char barcode[128];
    snprintf(barcode, sizeof(barcode), "STG-BIN-%s", barcode_suffix);
    int is_mono = strcmp(kind, "mono") == 0;

    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(e->db->conn,
                        "INSERT INTO bins (barcode, label, kind, mono_item_id, created_in_work_session_id) VALUES (?, ?, ?, ?, ?)",
                        -1, &stmt, NULL);
    sqlite3_bind_text(stmt, 1, barcode, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, label, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, kind, -1, SQLITE_TRANSIENT);
    if (is_mono) {
        sqlite3_bind_int64(stmt, 4, mono_item_id);
    } else {
        sqlite3_bind_null(stmt, 4);
    }
    sqlite3_bind_int64(stmt, 5, e->work_session_id);
    int rc = sqlite3_step(stmt);
    int64_t id = sqlite3_last_insert_rowid(e->db->conn);
    sqlite3_finalize(stmt);

    e->last_activity_at = time(NULL);
    pthread_mutex_unlock(&e->lock);

    if (rc != SQLITE_DONE) {
        return -2;
    }
    broadcast_buffer_changed(e);
    return id;
}

/* ---- status JSON ---- */

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

static char *lookup_name(db_t *db, const char *table, const char *column, int64_t id) {
    char sql[128];
    snprintf(sql, sizeof(sql), "SELECT %s FROM %s WHERE id = ?", column, table);
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db->conn, sql, -1, &stmt, NULL);
    sqlite3_bind_int64(stmt, 1, id);
    char *name = NULL;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        name = json_escape((const char *) sqlite3_column_text(stmt, 0));
    } else {
        name = json_escape("");
    }
    sqlite3_finalize(stmt);
    return name;
}

char *grammar_engine_status_json(grammar_engine_t *e) {
    pthread_mutex_lock(&e->lock);

    size_t cap = 512, len = 0;
    char *buf = malloc(cap);
    buf = json_append(buf, &len, &cap, "{");

    if (e->work_session_id == 0) {
        buf = json_append(buf, &len, &cap, "\"work_session\":null,");
    } else {
        char piece[128];
        snprintf(piece, sizeof(piece), "\"work_session\":{\"id\":%lld,\"status\":\"%s\"},",
                  (long long) e->work_session_id, e->work_session_status);
        buf = json_append(buf, &len, &cap, piece);
    }

    char piece[64];
    snprintf(piece, sizeof(piece), "\"focused_bin_id\":%lld,", (long long) e->focused_bin_id);
    buf = json_append(buf, &len, &cap, piece);

    buf = json_append(buf, &len, &cap, "\"open_bin_sessions\":[");
    int first = 1;
    for (bin_session_t *bs = e->bin_sessions; bs; bs = bs->next) {
        int item_count = 0;
        for (pending_item_t *p = bs->items; p; p = p->next) {
            item_count += p->quantity;
        }
        char entry[160];
        snprintf(entry, sizeof(entry), "%s{\"bin_id\":%lld,\"op_type\":\"%s\",\"item_count\":%d}",
                  first ? "" : ",", (long long) bs->bin_id, bs->op_type, item_count);
        buf = json_append(buf, &len, &cap, entry);
        first = 0;
    }
    buf = json_append(buf, &len, &cap, "],");

    buf = json_append(buf, &len, &cap, "\"buffered_operations\":[");
    if (e->work_session_id != 0) {
        sqlite3_stmt *stmt;
        sqlite3_prepare_v2(e->db->conn,
                            "SELECT id, op_type, item_id, bin_id, quantity, source, via_pack_item_id "
                            "FROM buffered_operations WHERE work_session_id = ? ORDER BY id",
                            -1, &stmt, NULL);
        sqlite3_bind_int64(stmt, 1, e->work_session_id);

        int op_first = 1;
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            int64_t op_id = sqlite3_column_int64(stmt, 0);
            const char *op_type = (const char *) sqlite3_column_text(stmt, 1);
            int64_t item_id = sqlite3_column_int64(stmt, 2);
            int64_t bin_id = sqlite3_column_int64(stmt, 3);
            int quantity = sqlite3_column_int(stmt, 4);
            const char *source = (const char *) sqlite3_column_text(stmt, 5);
            int has_pack = sqlite3_column_type(stmt, 6) != SQLITE_NULL;
            int64_t via_pack_item_id = has_pack ? sqlite3_column_int64(stmt, 6) : 0;

            char *item_name = lookup_name(e->db, "items", "name", item_id);
            char *bin_label = lookup_name(e->db, "bins", "label", bin_id);

            char entry[512];
            if (has_pack) {
                char *pack_name = lookup_name(e->db, "items", "name", via_pack_item_id);
                snprintf(entry, sizeof(entry),
                          "%s{\"id\":%lld,\"op_type\":\"%s\",\"item_id\":%lld,\"item_name\":\"%s\","
                          "\"bin_id\":%lld,\"bin_label\":\"%s\",\"quantity\":%d,\"source\":\"%s\","
                          "\"via_pack_item_id\":%lld,\"via_pack_name\":\"%s\"}",
                          op_first ? "" : ",", (long long) op_id, op_type, (long long) item_id, item_name,
                          (long long) bin_id, bin_label, quantity, source, (long long) via_pack_item_id, pack_name);
                free(pack_name);
            } else {
                snprintf(entry, sizeof(entry),
                          "%s{\"id\":%lld,\"op_type\":\"%s\",\"item_id\":%lld,\"item_name\":\"%s\","
                          "\"bin_id\":%lld,\"bin_label\":\"%s\",\"quantity\":%d,\"source\":\"%s\","
                          "\"via_pack_item_id\":null}",
                          op_first ? "" : ",", (long long) op_id, op_type, (long long) item_id, item_name,
                          (long long) bin_id, bin_label, quantity, source);
            }
            free(item_name);
            free(bin_label);
            buf = json_append(buf, &len, &cap, entry);
            op_first = 0;
        }
        sqlite3_finalize(stmt);
    }
    buf = json_append(buf, &len, &cap, "]}");

    pthread_mutex_unlock(&e->lock);
    return buf;
}
