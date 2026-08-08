#!/bin/sh
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$(uname -s)" != "Darwin" ] || ! command -v swiftc >/dev/null 2>&1; then
  exit 0
fi

source_file="$root/native/CalendarReader.swift"
plist_file="$root/native/CalendarReader-Info.plist"
application="$root/dist/CodexCalendarReader.app"
contents="$application/Contents"
executable="$contents/MacOS/CodexCalendarReader"
stamp="$root/dist/.calendar-reader-build-hash"
build_hash="$(shasum -a 256 "$source_file" "$plist_file" | shasum -a 256 | awk '{print $1}')"

if [ -x "$executable" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$build_hash" ]; then
  exit 0
fi

mkdir -p "$contents/MacOS"
cp "$plist_file" "$contents/Info.plist"
xcrun swiftc -O -parse-as-library "$source_file" -o "$executable"
printf '%s\n' "$build_hash" > "$stamp"
codesign --force --deep --sign - "$application" >/dev/null
