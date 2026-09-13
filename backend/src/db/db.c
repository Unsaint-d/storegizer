#include "db.h"

#include <stdio.h>
#include <stdlib.h>

static char *read_file(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        return NULL;
    }

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);

    char *buf = malloc((size_t) size + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }

    size_t read = fread(buf, 1, (size_t) size, f);
    buf[read] = '\0';
    fclose(f);
    return buf;
}

int db_open(db_t *db, const char *db_path, const char *schema_sql_path) {
    if (sqlite3_open(db_path, &db->conn) != SQLITE_OK) {
        fprintf(stderr, "db_open: sqlite3_open failed: %s\n", sqlite3_errmsg(db->conn));
        return -1;
    }

    char *schema_sql = read_file(schema_sql_path);
    if (!schema_sql) {
        fprintf(stderr, "db_open: could not read schema file %s\n", schema_sql_path);
        sqlite3_close(db->conn);
        return -1;
    }

    char *err = NULL;
    int rc = sqlite3_exec(db->conn, schema_sql, NULL, NULL, &err);
    free(schema_sql);

    if (rc != SQLITE_OK) {
        fprintf(stderr, "db_open: schema apply failed: %s\n", err);
        sqlite3_free(err);
        sqlite3_close(db->conn);
        return -1;
    }

    return 0;
}

void db_close(db_t *db) {
    if (db->conn) {
        sqlite3_close(db->conn);
        db->conn = NULL;
    }
}
