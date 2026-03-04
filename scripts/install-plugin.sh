#!/bin/bash
# Install Bookmark as a Claude Code plugin
# Usage: bash scripts/install-plugin.sh [--global]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$SCRIPT_DIR"
INSTALLED_PLUGINS="$HOME/.claude/plugins/installed_plugins.json"

register_plugin() {
  # Register bookmark in installed_plugins.json for Claude Code discovery
  node -e "
const fs = require('fs');
const path = '$INSTALLED_PLUGINS';
const installPath = '$1';
const now = new Date().toISOString();

let data = { version: 2, plugins: {} };
try {
  if (fs.existsSync(path)) {
    data = JSON.parse(fs.readFileSync(path, 'utf-8'));
  }
} catch {}

const key = 'bookmark@local';
if (data.plugins[key]) {
  data.plugins[key][0].installPath = installPath;
  data.plugins[key][0].lastUpdated = now;
} else {
  data.plugins[key] = [{
    scope: 'user',
    installPath: installPath,
    version: '0.2.1',
    installedAt: now,
    lastUpdated: now
  }];
}

fs.mkdirSync(require('path').dirname(path), { recursive: true });
fs.writeFileSync(path, JSON.stringify(data, null, 2));
"
}

if [[ "$1" == "--global" ]]; then
  # Global install — link plugin for all projects
  CLAUDE_PLUGINS_DIR="$HOME/.claude/plugins"
  mkdir -p "$CLAUDE_PLUGINS_DIR"

  # Create symlink
  LINK_PATH="$CLAUDE_PLUGINS_DIR/bookmark"
  if [ -L "$LINK_PATH" ]; then
    rm "$LINK_PATH"
  fi
  ln -sf "$PLUGIN_DIR" "$LINK_PATH"
  echo "Bookmark plugin linked globally: $LINK_PATH -> $PLUGIN_DIR"

  # Register in installed_plugins.json
  register_plugin "$PLUGIN_DIR"
  echo "Registered bookmark in Claude Code plugin registry"
else
  # Project-level install
  CWD="${2:-$(pwd)}"
  CLAUDE_DIR="$CWD/.claude"
  mkdir -p "$CLAUDE_DIR"

  # Register globally (commands/skills need global registration)
  CLAUDE_PLUGINS_DIR="$HOME/.claude/plugins"
  mkdir -p "$CLAUDE_PLUGINS_DIR"
  LINK_PATH="$CLAUDE_PLUGINS_DIR/bookmark"
  if [ ! -L "$LINK_PATH" ] && [ ! -d "$LINK_PATH" ]; then
    ln -sf "$PLUGIN_DIR" "$LINK_PATH"
  fi
  register_plugin "$PLUGIN_DIR"

  echo "Bookmark plugin installed for project: $CWD"
  echo ""
  echo "Commands available:"
  echo "  /bookmark:snapshot  — Take a manual snapshot"
  echo "  /bookmark:restore   — Restore from a snapshot"
  echo "  /bookmark:status    — Show snapshot stats"
  echo "  /bookmark:list      — List all snapshots"
fi

echo ""
echo "Done. Restart your Claude Code session to activate hooks."
