#include "classify.h"

#include <string.h>

#define BIN_PREFIX "STG-BIN-"

code_kind_t classify_code(const char *raw_code) {
    if (strncmp(raw_code, BIN_PREFIX, strlen(BIN_PREFIX)) == 0) {
        return CODE_KIND_BIN;
    }
    return CODE_KIND_ITEM;
}
