#ifndef STOREGIZER_WS_SERVER_H
#define STOREGIZER_WS_SERVER_H

typedef struct ws_server ws_server_t;

/* Starts a libwebsockets server on port, running its service loop on a
 * background thread. Connected clients just receive broadcast messages;
 * there is no client -> server protocol yet. */
ws_server_t *ws_server_start(int port);

/* Queues json for delivery to every currently connected client. Safe to
 * call from any thread (in particular, the evdev scanner thread). */
void ws_server_broadcast(ws_server_t *ws, const char *json);

void ws_server_stop(ws_server_t *ws);

#endif
