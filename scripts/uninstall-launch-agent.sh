#!/bin/zsh
set -euo pipefail

label="com.local.codex-telegram-assistant"
watchdog_label="$label.watchdog"
plist="$HOME/Library/LaunchAgents/$label.plist"
watchdog_plist="$HOME/Library/LaunchAgents/$watchdog_label.plist"
launchctl bootout "gui/$(id -u)/$watchdog_label" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
rm -f "$plist" "$watchdog_plist"
echo "Removed $label and $watchdog_label"
