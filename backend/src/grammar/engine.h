#ifndef STOREGIZER_GRAMMAR_ENGINE_H
#define STOREGIZER_GRAMMAR_ENGINE_H

#include "../db/db.h"
#include "../ws/ws_server.h"

#include <stdint.h>

typedef struct grammar_engine grammar_engine_t;

grammar_engine_t *grammar_engine_create(db_t *db, ws_server_t *ws);
void grammar_engine_destroy(grammar_engine_t *engine);

/* Entry point for every classified scan, from the real evdev scanner or the
 * HTTP debug-scan endpoint alike. Implements docs/scanning-grammar.md §4:
 * bin-scan-as-toggle, item accumulation into whichever bin is focused (or
 * into an unassigned add-staging list if none is), pack expansion, and the
 * over-removal guard. No-ops (logs and returns) if no work session is open. */
void grammar_engine_on_scan(grammar_engine_t *engine, const char *raw_code);

/* Work-session lifecycle (docs/scanning-grammar.md §6). Each returns 0 on
 * success, -1 if the requested transition isn't valid from the current
 * state (e.g. opening while one is already open/frozen).
 *
 * NOTE: open_session has no authentication gate yet -- README's open
 * question #3 (network auth) isn't resolved. Anyone who can reach the HTTP
 * API can currently open a session. Singleton enforcement (only one
 * open/frozen session at a time) and the freeze/restore mechanics are real,
 * just not yet gated behind who's allowed to call them. */
int grammar_engine_open_session(grammar_engine_t *engine);
int grammar_engine_commit_session(grammar_engine_t *engine);
int grammar_engine_rollback_session(grammar_engine_t *engine);
int grammar_engine_restore_session(grammar_engine_t *engine);

/* Manual buffer edits (docs/scanning-grammar.md §7) -- an operation doesn't
 * have to come from a scan. add/remove go through the same pack-expansion
 * and (for remove) over-removal validation as a scan would; returns the new
 * buffered_operations row count added (0 if rejected), or -1 if no session
 * is open. */
int grammar_engine_manual_operation(grammar_engine_t *engine, const char *op_type,
                                     int64_t item_id, int64_t bin_id, int quantity);
int grammar_engine_delete_operation(grammar_engine_t *engine, int64_t operation_id);
int grammar_engine_update_operation_quantity(grammar_engine_t *engine, int64_t operation_id, int quantity);

/* Creating a bin or item is only ever done from the panel inside an open
 * work session -- same single gate as everything else here, not a
 * separately-reachable admin surface (docs/scanning-grammar.md §3). Both
 * return the new row id (> 0) on success, -1 if no work session is open,
 * -2 on a DB-level conflict (e.g. duplicate barcode).
 *
 * barcode may be NULL/empty for grammar_engine_create_item (filled in
 * later, or left for a scan to claim); bins always get one, derived from
 * barcode_suffix. mono_item_id is ignored unless kind is "mono". */
int64_t grammar_engine_create_item(grammar_engine_t *engine, const char *name, const char *barcode);
int64_t grammar_engine_create_bin(grammar_engine_t *engine, const char *label, const char *kind,
                                   const char *barcode_suffix, int64_t mono_item_id);

/* JSON status: work session state, current focus, open (not yet closed)
 * bin-sessions, and the buffered operations recorded so far. Caller frees. */
char *grammar_engine_status_json(grammar_engine_t *engine);

#endif
