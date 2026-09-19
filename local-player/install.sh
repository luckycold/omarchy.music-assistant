#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
PATH="/usr/bin:/usr/local/bin:${HOME}/.local/bin:${PATH}"
[[ -x /usr/bin/python3 ]]
/usr/bin/python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)'
/usr/bin/python3 -c 'import dbus; from gi.repository import GLib'
runtime="$HOME/.local/share/omarchy-ma-player"
install -d -m 700 "$runtime" "$HOME/.local/state/music-assistant-player"
install -d "$HOME/.local/bin" "$HOME/.config/systemd/user"
if command -v uv >/dev/null; then
  uv venv --python 3.12 "$runtime/venv"
  uv pip install --python "$runtime/venv/bin/python" -r requirements.txt
else
  /usr/bin/python3 -m venv "$runtime/venv"
  "$runtime/venv/bin/pip" install -r requirements.txt
fi
install -m 600 remote_transport.py native_adapter.py native_daemon.py mpris.py "$runtime/"
install -m 755 bin/omarchy-ma-player "$HOME/.local/bin/omarchy-ma-player"
install -m 600 omarchy-ma-player.service omarchy-ma-mpris.service "$HOME/.config/systemd/user/"
PYTHONPATH=. "$runtime/venv/bin/python" -m unittest discover -s test -q
systemctl --user daemon-reload
printf '%s\n' 'Installed without starting or enabling. Configure localPlayer, then run omarchy-ma-player start.'
