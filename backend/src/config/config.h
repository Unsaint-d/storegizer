#ifndef STOREGIZER_CONFIG_H
#define STOREGIZER_CONFIG_H

/* Admin-editable server settings, backed by a JSON file on disk rather than
 * the database (docs/scanning-grammar.md §8) -- this is server
 * configuration, not warehouse data, so it lives with the rest of the
 * deployment's config instead of inside the SQLite file. */
typedef struct {
    int scan_op_timeout_seconds;
} server_config_t;

void config_set_defaults(server_config_t *cfg);

/* Loads from path, falling back to defaults for any field missing from the
 * file (including a missing file entirely). Always succeeds -- a malformed
 * file is logged and treated as absent, since there's no sane way to make a
 * config file's syntax error stop the server from starting. */
void config_load(server_config_t *cfg, const char *path);

/* Writes cfg to path as JSON. Returns 0 on success, -1 if the file
 * couldn't be opened for writing. */
int config_save(const server_config_t *cfg, const char *path);

#endif
