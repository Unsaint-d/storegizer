#ifndef STOREGIZER_DB_H
#define STOREGIZER_DB_H

#include <sqlite3.h>

typedef struct {
    sqlite3 *conn;
} db_t;

/* Opens (creating if needed) the SQLite file at db_path in WAL mode and
 * applies schema_sql_path (idempotent CREATE TABLE IF NOT EXISTS statements).
 * Returns 0 on success, -1 on failure. */
int db_open(db_t *db, const char *db_path, const char *schema_sql_path);
void db_close(db_t *db);

#endif
