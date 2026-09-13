#include "config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void config_set_defaults(server_config_t *cfg) {
    cfg->scan_op_timeout_seconds = 10;
}

static char *read_file(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        return NULL;
    }

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);

    char *buf = malloc((size_t) size + 1);
    size_t read = fread(buf, 1, (size_t) size, f);
    buf[read] = '\0';
    fclose(f);
    return buf;
}

/* Same deliberately minimal approach as the HTTP layer's request-body
 * parsing: finds "key": <int> in a flat JSON object. Not a general parser. */
static int json_int_field(const char *json, const char *key, int fallback) {
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
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
    return (int) value;
}

void config_load(server_config_t *cfg, const char *path) {
    config_set_defaults(cfg);

    char *json = read_file(path);
    if (!json) {
        fprintf(stderr, "config: %s not found, using defaults\n", path);
        return;
    }

    cfg->scan_op_timeout_seconds = json_int_field(json, "scan_op_timeout_seconds", cfg->scan_op_timeout_seconds);
    free(json);
}

int config_save(const server_config_t *cfg, const char *path) {
    FILE *f = fopen(path, "wb");
    if (!f) {
        fprintf(stderr, "config: failed to write %s\n", path);
        return -1;
    }
    fprintf(f, "{\n  \"scan_op_timeout_seconds\": %d\n}\n", cfg->scan_op_timeout_seconds);
    fclose(f);
    return 0;
}
