#!/bin/sh
# Ensure pre-installed plugins are available
PLUGIN_DIR="$HOME/.claude/plugins/marketplaces"
mkdir -p "$PLUGIN_DIR" 2>/dev/null || true
if [ -d /opt/claude-plugins/everything-claude-code ] && [ ! -e "$PLUGIN_DIR/everything-claude-code" ]; then
    ln -s /opt/claude-plugins/everything-claude-code "$PLUGIN_DIR/everything-claude-code"
fi

# Run as root with IS_SANDBOX=1 (allows --dangerously-skip-permissions)
exec node dist/main.js "$@"
