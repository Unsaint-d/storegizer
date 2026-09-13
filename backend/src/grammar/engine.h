#ifndef STOREGIZER_GRAMMAR_ENGINE_H
#define STOREGIZER_GRAMMAR_ENGINE_H

#include "../db/db.h"
#include "../ws/ws_server.h"

#include <stdint.h>

typedef struct grammar_engine grammar_engine_t;

/* config_path: JSON file backing admin-editable settings (§8 of the
 * grammar doc) -- server configuration, not warehouse data, so it lives on
 * disk next to the rest of the deployment's config rather than in SQLite. */
grammar_engine_t *grammar_engine_create(db_t *db, ws_server_t *ws, const char *config_path);
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
 * barcode_suffix. mono_item_id is ignored unless kind is "mono".
 *
 * The new row is tagged with the work session that created it (as is an
 * item auto-created for an unrecognized barcode during a scan) -- rolling
 * that session back deletes it again, same as any other in-session change. */
/* tag_names: independent properties to attach (e.g. "Потайной") -- found by
 * name if an existing tag already has it, otherwise created inline as an
 * unscoped (scope_category_id NULL) tag, same as a pack's inline
 * child-item creation. Unlike category_id (a strict "is-a" hierarchy), an
 * item can have any number of these and they carry no nesting relationship
 * to each other -- what they do carry is an optional scope (see
 * grammar_engine_ensure_tag below), checked here: if an existing tag named
 * in tag_names is scoped, category_id must be that scope or a descendant
 * of it, or the whole call is rejected (-3) before anything is written --
 * deliberately not "create the item, then fail linking a tag" halfway.
 *
 * To set up a properly scoped tag ahead of time (so it doesn't get
 * created unscoped the first time someone types its name here), create it
 * explicitly via grammar_engine_ensure_tag first -- typically from an
 * admin panel action, not from this inline path. */
int64_t grammar_engine_create_item(grammar_engine_t *engine, const char *name, const char *barcode,
                                    int64_t category_id, const char **tag_names, int tag_count);
int64_t grammar_engine_create_bin(grammar_engine_t *engine, const char *label, const char *kind,
                                   const char *barcode_suffix, int64_t mono_item_id);

/* Finds or creates a single tag by name -- the standalone admin-panel path,
 * not tied to creating an item. scope_category_id (0 = none) restricts the
 * tag to that category or its descendants; only used if the tag doesn't
 * already exist -- reusing an existing tag never changes its scope here.
 * Same session-gating as everything else; returns -1 if no session is
 * open, -2 if name is empty. */
int64_t grammar_engine_ensure_tag(grammar_engine_t *engine, const char *name, int64_t scope_category_id);

/* Category path ("Крепёж" -> "Винт" -> "М2"): finds-or-creates each segment
 * under the previous one (existing prefix segments are reused, not
 * duplicated) and returns the id of the last one -- the id an item's
 * category_id points to. Same session-gating and rollback behavior as
 * create_item/create_bin. Returns -1 if no session is open, -2 if path_len
 * is 0 or any segment is empty. */
int64_t grammar_engine_ensure_category_path(grammar_engine_t *engine, const char **path, int path_len);

/* JSON status: work session state, current focus, open (not yet closed)
 * bin-sessions, and the buffered operations recorded so far. Caller frees. */
char *grammar_engine_status_json(grammar_engine_t *engine);

/* Admin-editable settings (docs/scanning-grammar.md §8), file-backed --
 * see config.h. JSON is the current config, e.g. {"scan_op_timeout_seconds":
 * 10}. Caller frees. update_setting returns 0 on success, -1 if key isn't a
 * known setting or the file couldn't be written (config stays applied in
 * memory even if the write fails, so it isn't silently lost until restart). */
char *grammar_engine_settings_json(grammar_engine_t *engine);
int grammar_engine_update_setting(grammar_engine_t *engine, const char *key, int value);

#endif
