#!/bin/zsh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
node_path="$(command -v node)"
label="com.local.codex-telegram-assistant"
plist="$HOME/Library/LaunchAgents/$label.plist"
logs="$HOME/Library/Logs/CodexTelegramAssistant"
service_path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ ! -f "$root/.env" ]]; then
  echo "Missing $root/.env"
  exit 1
fi
if [[ ! -f "$root/dist/main.js" ]]; then
  echo "Run npm install && npm run build first"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$logs"
/usr/libexec/PlistBuddy -c "Clear dict" "$plist" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :Label string $label" "$plist"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$plist"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string $node_path" "$plist"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string $root/dist/main.js" "$plist"
/usr/libexec/PlistBuddy -c "Add :WorkingDirectory string $root" "$plist"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$plist"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PATH string $service_path" "$plist"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "$plist"
/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "$plist"
/usr/libexec/PlistBuddy -c "Add :ProcessType string Background" "$plist"
/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 10" "$plist"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $logs/assistant.log" "$plist"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $logs/assistant.error.log" "$plist"

launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/$label"
echo "Installed $label"
