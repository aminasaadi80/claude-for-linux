#!/usr/bin/env bash
# Build + install "Claude برای لینوکس" as a native desktop app, then launch it.
#
# Run from a real terminal so the sudo prompt works:
#     bash install.sh
#
# Two things this script needs that only YOU can provide:
#   * sudo  — to install the system libraries Tauri links against
#   * network for cargo — crates.io is filtered here; if `cargo fetch` fails,
#     run this whole script behind your proxy/VPN, e.g.:
#         HTTPS_PROXY=http://127.0.0.1:PORT bash install.sh

set -e
cd "$(dirname "$0")"

echo "==> 1/4  System libraries (needs sudo) ..."
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

echo "==> 2/4  Toolchain ..."
. "$HOME/.cargo/env"

echo "==> 3/4  Building the installer (this compiles Rust — first run is slow) ..."
# If cargo can't reach crates.io, set HTTPS_PROXY before running this script.
npm run tauri build

echo "==> 4/4  Installing the .deb and launching ..."
DEB=$(ls -t src-tauri/target/release/bundle/deb/*.deb 2>/dev/null | head -1)
if [ -n "$DEB" ]; then
  sudo dpkg -i "$DEB" || sudo apt -f install -y
  echo "نصب شد. اجرا..."
  setsid claude-linux >/dev/null 2>&1 < /dev/null &
  echo "✅ تمام — اپ از منوی برنامه‌ها هم در دسترس است (Claude برای لینوکس)."
else
  # Fall back to the portable AppImage if the .deb wasn't produced
  APP=$(ls -t src-tauri/target/release/bundle/appimage/*.AppImage 2>/dev/null | head -1)
  if [ -n "$APP" ]; then
    chmod +x "$APP"
    echo "بسته‌ی .deb ساخته نشد، ولی AppImage آماده است:"
    echo "  $APP"
    setsid "$APP" >/dev/null 2>&1 < /dev/null &
    echo "✅ اجرا شد."
  else
    echo "❌ خروجی بسته پیدا نشد — لاگ ساخت را بالاتر ببین."
    exit 1
  fi
fi
