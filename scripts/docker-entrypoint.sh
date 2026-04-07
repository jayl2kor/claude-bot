#!/bin/sh
# Fix ownership on mounted volumes
chown -R node:node /app/data /app/config 2>/dev/null || true

# Ensure pre-installed plugins are available to node user
PLUGIN_DIR="/home/node/.claude/plugins/marketplaces"
mkdir -p "$PLUGIN_DIR" 2>/dev/null || true
if [ -d /opt/claude-plugins/everything-claude-code ] && [ ! -e "$PLUGIN_DIR/everything-claude-code" ]; then
    ln -s /opt/claude-plugins/everything-claude-code "$PLUGIN_DIR/everything-claude-code"
fi
chown -R node:node /home/node/.claude 2>/dev/null || true

# Drop to node user and run the daemon
exec gosu node node dist/main.js "$@"
