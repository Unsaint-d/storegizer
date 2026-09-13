#include "scanner.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/input-event-codes.h>
#include <libevdev/libevdev.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define BARCODE_MAX 256

struct scanner {
    int fd;
    struct libevdev *dev;
    pthread_t thread;
    volatile int stop_flag;
    scanner_scan_cb cb;
    void *user_data;
};

/* US QWERTY keycode -> lowercase char. Covers what barcode payloads
 * realistically contain (digits, letters, a few separators); scanners
 * emit plain HID keycodes same as a real keyboard, so anything typed
 * with other modifiers (numpad, punctuation rows) is simply ignored. */
static char keycode_to_lower(unsigned int code) {
    static const struct { unsigned int code; char ch; } map[] = {
        {KEY_1, '1'}, {KEY_2, '2'}, {KEY_3, '3'}, {KEY_4, '4'}, {KEY_5, '5'},
        {KEY_6, '6'}, {KEY_7, '7'}, {KEY_8, '8'}, {KEY_9, '9'}, {KEY_0, '0'},
        {KEY_Q, 'q'}, {KEY_W, 'w'}, {KEY_E, 'e'}, {KEY_R, 'r'}, {KEY_T, 't'},
        {KEY_Y, 'y'}, {KEY_U, 'u'}, {KEY_I, 'i'}, {KEY_O, 'o'}, {KEY_P, 'p'},
        {KEY_A, 'a'}, {KEY_S, 's'}, {KEY_D, 'd'}, {KEY_F, 'f'}, {KEY_G, 'g'},
        {KEY_H, 'h'}, {KEY_J, 'j'}, {KEY_K, 'k'}, {KEY_L, 'l'},
        {KEY_Z, 'z'}, {KEY_X, 'x'}, {KEY_C, 'c'}, {KEY_V, 'v'}, {KEY_B, 'b'},
        {KEY_N, 'n'}, {KEY_M, 'm'},
        {KEY_MINUS, '-'}, {KEY_SLASH, '/'}, {KEY_SPACE, ' '},
    };

    for (size_t i = 0; i < sizeof(map) / sizeof(map[0]); i++) {
        if (map[i].code == code) {
            return map[i].ch;
        }
    }
    return '\0';
}

static void *scan_loop(void *arg) {
    scanner_t *s = arg;
    char barcode[BARCODE_MAX + 1];
    size_t len = 0;
    int shift_held = 0;

    struct pollfd pfd = {.fd = s->fd, .events = POLLIN};

    while (!s->stop_flag) {
        int pret = poll(&pfd, 1, 200);
        if (pret <= 0) {
            continue;
        }

        struct input_event ev;
        int rc;
        while ((rc = libevdev_next_event(s->dev, LIBEVDEV_READ_FLAG_NORMAL, &ev)) == LIBEVDEV_READ_STATUS_SUCCESS) {
            if (ev.type != EV_KEY) {
                continue;
            }

            if (ev.code == KEY_LEFTSHIFT || ev.code == KEY_RIGHTSHIFT) {
                if (ev.value == 1 || ev.value == 0) {
                    shift_held = ev.value;
                }
                continue;
            }

            if (ev.value != 1) {
                continue; /* only handle key-down; ignore up/repeat */
            }

            if (ev.code == KEY_ENTER || ev.code == KEY_KPENTER) {
                if (len > 0) {
                    barcode[len] = '\0';
                    s->cb(barcode, s->user_data);
                    len = 0;
                }
                continue;
            }

            char c = keycode_to_lower(ev.code);
            if (c != '\0' && len < BARCODE_MAX) {
                barcode[len++] = shift_held ? (char) toupper((unsigned char) c) : c;
            }
        }
    }

    return NULL;
}

scanner_t *scanner_evdev_start(const char *device_path, scanner_scan_cb cb, void *user_data) {
    int fd = open(device_path, O_RDONLY | O_NONBLOCK);
    if (fd < 0) {
        fprintf(stderr, "scanner_evdev_start: open(%s) failed: %s\n", device_path, strerror(errno));
        return NULL;
    }

    struct libevdev *dev = NULL;
    int rc = libevdev_new_from_fd(fd, &dev);
    if (rc < 0) {
        fprintf(stderr, "scanner_evdev_start: libevdev_new_from_fd failed: %s\n", strerror(-rc));
        close(fd);
        return NULL;
    }

    if (libevdev_grab(dev, LIBEVDEV_GRAB) != 0) {
        fprintf(stderr, "scanner_evdev_start: exclusive grab of %s failed (in use, or missing permission)\n", device_path);
        libevdev_free(dev);
        close(fd);
        return NULL;
    }

    scanner_t *s = malloc(sizeof(scanner_t));
    s->fd = fd;
    s->dev = dev;
    s->stop_flag = 0;
    s->cb = cb;
    s->user_data = user_data;

    if (pthread_create(&s->thread, NULL, scan_loop, s) != 0) {
        fprintf(stderr, "scanner_evdev_start: pthread_create failed\n");
        libevdev_grab(dev, LIBEVDEV_UNGRAB);
        libevdev_free(dev);
        close(fd);
        free(s);
        return NULL;
    }

    fprintf(stderr, "scanner_evdev_start: capturing %s (%s)\n", device_path, libevdev_get_name(dev));
    return s;
}

void scanner_evdev_stop(scanner_t *s) {
    if (!s) {
        return;
    }

    s->stop_flag = 1;
    pthread_join(s->thread, NULL);
    libevdev_grab(s->dev, LIBEVDEV_UNGRAB);
    libevdev_free(s->dev);
    close(s->fd);
    free(s);
}
