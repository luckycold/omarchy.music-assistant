#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v node >/dev/null
command -v npm >/dev/null
command -v python3 >/dev/null
command -v chromium >/dev/null
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
npm ci --no-audit --no-fund
npm run check
runtime="$HOME/.local/share/omarchy-ma-player"
install -d -m 700 "$runtime" "$HOME/.local/state/music-assistant-player"
install -d "$HOME/.local/bin" "$HOME/.config/systemd/user"
install -m 600 dist/daemon.mjs dist/browser.js "$runtime/"
if [[ -f dist/browser.js.LEGAL.txt ]]; then install -m 600 dist/browser.js.LEGAL.txt "$runtime/"; fi
cp -R dist/licenses "$runtime/"
install -m 600 NOTICE.md "$runtime/"
install -m 755 bin/omarchy-ma-player "$HOME/.local/bin/omarchy-ma-player"
install -m 600 omarchy-ma-player.service "$HOME/.config/systemd/user/omarchy-ma-player.service"
systemctl --user daemon-reload
printf '%s\n' 'Installed without starting or enabling. Configure localPlayer, then run omarchy-ma-player start.'
