#!/bin/zsh
set -euo pipefail

label="com.local.codex-telegram-assistant"
plist="$HOME/Library/LaunchAgents/$label.plist"
launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
rm -f "$plist"
echo "Removed $label"
