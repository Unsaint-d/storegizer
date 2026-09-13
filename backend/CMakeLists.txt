cmake_minimum_required(VERSION 3.16)
project(storegizer_backend C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(MICROHTTPD REQUIRED libmicrohttpd)
pkg_check_modules(SQLITE3 REQUIRED sqlite3)
pkg_check_modules(LWS REQUIRED libwebsockets)
pkg_check_modules(EVDEV REQUIRED libevdev)

add_executable(storegizer_backend
    src/main.c
    src/http/http_server.c
    src/ws/ws_server.c
    src/db/db.c
    src/scanner/scanner_evdev.c
    src/grammar/classify.c
    src/grammar/engine.c
    src/config/config.c
)

target_include_directories(storegizer_backend PRIVATE
    src
    ${MICROHTTPD_INCLUDE_DIRS}
    ${SQLITE3_INCLUDE_DIRS}
    ${LWS_INCLUDE_DIRS}
    ${EVDEV_INCLUDE_DIRS}
)

target_compile_options(storegizer_backend PRIVATE
    -Wall -Wextra
    ${MICROHTTPD_CFLAGS_OTHER}
    ${SQLITE3_CFLAGS_OTHER}
    ${LWS_CFLAGS_OTHER}
    ${EVDEV_CFLAGS_OTHER}
)

target_link_libraries(storegizer_backend PRIVATE
    ${MICROHTTPD_LIBRARIES}
    ${SQLITE3_LIBRARIES}
    ${LWS_LIBRARIES}
    ${EVDEV_LIBRARIES}
    pthread
)
