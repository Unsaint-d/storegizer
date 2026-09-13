FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config \
    libmicrohttpd-dev libsqlite3-dev libwebsockets-dev libevdev-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY CMakeLists.txt ./
COPY src ./src
COPY sql ./sql

RUN cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j

ENV STOREGIZER_DB_PATH=/data/storegizer.db
ENV STOREGIZER_SCHEMA_PATH=/app/sql/schema.sql
ENV HTTP_PORT=8080
ENV WS_PORT=8081

VOLUME ["/data"]
EXPOSE 8080 8081

CMD ["./build/storegizer_backend"]
