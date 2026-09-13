#include "ws_server.h"

#include <libwebsockets.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define RING_CAPACITY 64

typedef struct {
    uint64_t seq;
    char *payload; /* LWS_PRE bytes of lws write headroom, then the text */
    size_t len;    /* length of the text, not counting the headroom */
} ring_slot_t;

typedef struct per_session_data {
    struct lws *wsi;
    uint64_t next_wanted; /* seq this client is waiting to send next */
    struct per_session_data *next;
} per_session_data_t;

struct ws_server {
    struct lws_context *context;
    pthread_t thread;
    volatile int stop_flag;

    /* Broadcast state: a small ring of recent messages plus the list of
     * connected sessions, each tracking its own read position. A client
     * that falls behind the ring's capacity just skips ahead to the
     * oldest message still buffered -- acceptable for a live status
     * feed where only the current state matters. */
    pthread_mutex_t lock;
    ring_slot_t ring[RING_CAPACITY];
    uint64_t next_seq;
    uint64_t oldest_seq;
    per_session_data_t *sessions;
};

static int callback_scan_events(struct lws *wsi, enum lws_callback_reasons reason,
                                 void *user, void *in, size_t len) {
    per_session_data_t *pss = (per_session_data_t *) user;
    ws_server_t *ws = (ws_server_t *) lws_context_user(lws_get_context(wsi));
    (void) in;
    (void) len;

    switch (reason) {
    case LWS_CALLBACK_ESTABLISHED:
        pthread_mutex_lock(&ws->lock);
        pss->wsi = wsi;
        pss->next_wanted = ws->next_seq; /* only future events, no backlog */
        pss->next = ws->sessions;
        ws->sessions = pss;
        pthread_mutex_unlock(&ws->lock);
        break;

    case LWS_CALLBACK_CLOSED: {
        pthread_mutex_lock(&ws->lock);
        per_session_data_t **pp = &ws->sessions;
        while (*pp) {
            if (*pp == pss) {
                *pp = pss->next;
                break;
            }
            pp = &(*pp)->next;
        }
        pthread_mutex_unlock(&ws->lock);
        break;
    }

    case LWS_CALLBACK_SERVER_WRITEABLE: {
        pthread_mutex_lock(&ws->lock);

        if (pss->next_wanted < ws->oldest_seq) {
            pss->next_wanted = ws->oldest_seq;
        }

        if (pss->next_wanted >= ws->next_seq) {
            pthread_mutex_unlock(&ws->lock);
            break;
        }

        ring_slot_t *slot = &ws->ring[pss->next_wanted % RING_CAPACITY];
        lws_write(wsi, (unsigned char *) slot->payload + LWS_PRE, slot->len, LWS_WRITE_TEXT);
        pss->next_wanted++;
        int more_pending = pss->next_wanted < ws->next_seq;

        pthread_mutex_unlock(&ws->lock);

        if (more_pending) {
            lws_callback_on_writable(wsi);
        }
        break;
    }

    default:
        break;
    }

    return 0;
}

static const struct lws_protocols protocols[] = {
    {
        .name = "scan-events",
        .callback = callback_scan_events,
        .per_session_data_size = sizeof(per_session_data_t),
    },
    {.name = NULL},
};

static void *service_thread(void *arg) {
    ws_server_t *ws = arg;
    while (!ws->stop_flag) {
        lws_service(ws->context, 1000);
    }
    return NULL;
}

ws_server_t *ws_server_start(int port) {
    ws_server_t *ws = calloc(1, sizeof(ws_server_t));
    if (!ws) {
        return NULL;
    }

    struct lws_context_creation_info info;
    memset(&info, 0, sizeof(info));
    info.port = port;
    info.protocols = protocols;
    info.gid = -1;
    info.uid = -1;
    info.user = ws;

    ws->context = lws_create_context(&info);
    if (!ws->context) {
        free(ws);
        return NULL;
    }

    pthread_mutex_init(&ws->lock, NULL);

    if (pthread_create(&ws->thread, NULL, service_thread, ws) != 0) {
        lws_context_destroy(ws->context);
        pthread_mutex_destroy(&ws->lock);
        free(ws);
        return NULL;
    }

    return ws;
}

void ws_server_broadcast(ws_server_t *ws, const char *json) {
    size_t len = strlen(json);
    char *payload = malloc(LWS_PRE + len);
    if (!payload) {
        return;
    }
    memcpy(payload + LWS_PRE, json, len);

    pthread_mutex_lock(&ws->lock);

    uint64_t seq = ws->next_seq++;
    ring_slot_t *slot = &ws->ring[seq % RING_CAPACITY];
    free(slot->payload);
    slot->seq = seq;
    slot->payload = payload;
    slot->len = len;

    if (seq >= ws->oldest_seq + RING_CAPACITY) {
        ws->oldest_seq = seq - RING_CAPACITY + 1;
    }

    for (per_session_data_t *pss = ws->sessions; pss; pss = pss->next) {
        lws_callback_on_writable(pss->wsi);
    }

    pthread_mutex_unlock(&ws->lock);
}

void ws_server_stop(ws_server_t *ws) {
    if (!ws) {
        return;
    }

    ws->stop_flag = 1;
    lws_cancel_service(ws->context);
    pthread_join(ws->thread, NULL);
    lws_context_destroy(ws->context);
    pthread_mutex_destroy(&ws->lock);

    for (int i = 0; i < RING_CAPACITY; i++) {
        free(ws->ring[i].payload);
    }
    free(ws);
}
