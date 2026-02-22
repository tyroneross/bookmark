#!/bin/bash
# Install Bookmark as a Claude Code plugin
# Usage: bash scripts/install-plugin.sh [--global]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$SCRIPT_DIR"

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
else
  # Project-level install
  CWD="${2:-$(pwd)}"
  CLAUDE_DIR="$CWD/.claude"
  mkdir -p "$CLAUDE_DIR"

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
