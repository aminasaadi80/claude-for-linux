#!/usr/bin/env bash
# Bump the app version everywhere it lives, in one shot:
#   package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml (+ Cargo.lock)
#
# Usage:  scripts/bump-version.sh 0.6.0
set -euo pipefail
cd "$(dirname "$0")/.."

NEW="${1:-}"
if [[ ! "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <x.y.z>" >&2
  exit 1
fi

OLD=$(grep -oP '"version": "\K[0-9.]+' package.json)
if [[ "$OLD" == "$NEW" ]]; then
  echo "already at $NEW" >&2
  exit 0
fi

sed -i "s/\"version\": \"$OLD\"/\"version\": \"$NEW\"/" package.json src-tauri/tauri.conf.json
sed -i "0,/^version = \"$OLD\"/s//version = \"$NEW\"/" src-tauri/Cargo.toml
# keep Cargo.lock in sync without a full build
(cd src-tauri && cargo update -p claude-linux --offline -q 2>/dev/null || cargo check -q 2>/dev/null || true)

echo "bumped: $OLD → $NEW"
grep -Hn "$NEW" package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml | head -3
