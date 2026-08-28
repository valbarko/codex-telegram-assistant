#!/bin/zsh
set -euo pipefail

version="v0.15.6"
revision="4dbf4f9f9a5ff3a53ade848d7ba4e3df13db859b"
data_root="${ASSISTANT_DATA_DIR:-$HOME/.local/share/codex-telegram-assistant}"
install_dir="${1:-$data_root/bin}"
source_root="$(mktemp -d "${TMPDIR:-/tmp}/codex-fluidaudio.XXXXXX")"

cleanup() {
  rm -rf -- "$source_root"
}
trap cleanup EXIT

git clone --quiet --depth 1 --branch "$version" https://github.com/FluidInference/FluidAudio.git "$source_root/source"
actual_revision="$(git -C "$source_root/source" rev-parse HEAD)"
if [[ "$actual_revision" != "$revision" ]]; then
  echo "FluidAudio $version resolved to unexpected revision $actual_revision" >&2
  exit 1
fi

swift build --package-path "$source_root/source" -c release --product fluidaudiocli
build_dir="$(swift build --package-path "$source_root/source" -c release --show-bin-path)"
mkdir -p "$install_dir"
install -m 755 "$build_dir/fluidaudiocli" "$install_dir/fluidaudiocli"
for bundle in "$build_dir"/*.bundle; do
  [[ -e "$bundle" ]] || continue
  /usr/bin/ditto "$bundle" "$install_dir/${bundle:t}"
done

echo "Installed FluidAudio $version at $install_dir/fluidaudiocli"
