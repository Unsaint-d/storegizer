#ifndef STOREGIZER_CLASSIFY_H
#define STOREGIZER_CLASSIFY_H

typedef enum {
    CODE_KIND_ITEM,
    CODE_KIND_BIN,
} code_kind_t;

/* Classifies a raw scanned string per docs/scanning-grammar.md §1: codes the
 * operator prints themself (bins) carry a reserved prefix; everything else
 * -- including manufacturer barcodes the operator has no control over -- is
 * an item. The STG-SVC- service-code prefix is reserved in the scheme but
 * has no defined codes yet (STOP_CUR_OP turned out unnecessary), so it isn't
 * classified here. */
code_kind_t classify_code(const char *raw_code);

#endif
