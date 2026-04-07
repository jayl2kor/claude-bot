#!/bin/sh
# Fix ownership on mounted volumes, then drop to node user
chown -R node:node /app/data /app/config 2>/dev/null || true
exec su-exec node node dist/main.js "$@"
