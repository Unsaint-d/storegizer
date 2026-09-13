FROM node:20-bookworm-slim

# node-gyp needs a compiler + python for the serial/BLE native bindings
# pulled in by @mmote/niimbluelib (serialport, @stoprocent/noble).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ libudev-dev libbluetooth-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

EXPOSE 5000
CMD ["npm", "start"]
