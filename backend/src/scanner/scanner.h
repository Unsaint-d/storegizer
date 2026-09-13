#ifndef STOREGIZER_SCANNER_H
#define STOREGIZER_SCANNER_H

typedef void (*scanner_scan_cb)(const char *barcode, void *user_data);

typedef struct scanner scanner_t;

/* Opens device_path (e.g. "/dev/input/event5"), exclusively grabs it
 * (EVIOCGRAB) so scanned keystrokes never reach the console/X input focus,
 * and runs a background thread that assembles keypresses into barcodes,
 * calling cb with each complete barcode on Enter.
 *
 * Returns NULL if the device can't be opened or grabbed (wrong path, no
 * permission, already grabbed) -- callers should fall back to the HTTP
 * debug-scan endpoint in that case, e.g. when running in a dev container
 * without real USB/HID passthrough. */
scanner_t *scanner_evdev_start(const char *device_path, scanner_scan_cb cb, void *user_data);

/* Stops the background thread, ungrabs and closes the device. */
void scanner_evdev_stop(scanner_t *scanner);

#endif
