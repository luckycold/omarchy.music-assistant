# Production remote local player

Node 22+, npm, Python 3 with dbus-python and PyGObject, Chromium, a systemd user
session/session D-Bus, and working PipeWire/PulseAudio are required. On Arch the
Python bindings are `python-dbus` and `python-gobject`. Run as the desktop user,
**not root**.

```sh
cd "$HOME/.config/omarchy/plugins/io.github.manologarciadev.music-assistant/local-player"
./install.sh
```

The installer runs `npm ci` and `npm run check` itself, then installs bundles outside the watched plugin tree to
`~/.local/share/omarchy-ma-player`, installs `~/.local/bin/omarchy-ma-player`
and the `omarchy-ma-player.service` / `omarchy-ma-mpris.service` user units,
and reloads systemd. The player starts its MPRIS companion as a dependency.
It does **not** start/enable playback or edit existing config.

Merge into existing `~/.config/music-assistant/config.json` (retain url/token):

```json
{
  "url": "https://your-existing-server",
  "token": "<existing-access-token>",
  "localPlayer": {
    "enabled": true,
    "remoteId": "<exact-26-character-remote-ID>",
    "signalingUrl": "wss://signaling.music-assistant.io/ws",
    "name": "Laptop",
    "forceRelay": false
  }
}
```

Config must be owner-owned regular file with no group/other permissions
(`chmod 600 ~/.config/music-assistant/config.json`). Malformed IDs are rejected,
not normalized. WSS is required; credentials/query/fragment in signaling URL are
rejected. Name defaults to Laptop; forceRelay defaults false. No configuration
or access token is exposed through status, argv or logs. Restart after changes.

## CLI contract

- `omarchy-ma-player status`: one JSON object (no wrapper), including phase,
  ready, playerId, playing, error, codec, timeSynced, channel.rxBytes/rxBinary,
  transport.localCandidateType and transport.receivedBytes. Stopped is exit 0.
- `omarchy-ma-player request`: reads ONE JSON line from stdin
  `{"command":"players/all","args":{}}`; stdout is `{"result":...}` or
  `{"error":"SAFE_CODE"}` with nonzero exit on error. Never put secrets in argv.
- `start`, `stop`, `restart`: corresponding `systemctl --user` service operation.
- `enable`, `disable`: manage autostart only, not current running state.

The socket protocol is one NDJSON request per connection with the same result
wrapper. `local/status` is reserved locally. All other requests use the browser's
**same authenticated MA API session**, preserving private-player permissions.
Auth namespace and manual web-player pairing are prohibited. Arbitrary successful
API results may contain sensitive user data: only status/errors are sanitized.
Limits: 64 KiB requests, 8 MiB responses, 32 pending RPCs, 30 s remote RPC deadline,
35 s bridge deadline, 40 s CLI socket timeout. Browser startup/heartbeat watchdog
is 15 s. Transport establishment and pairing have separate bounded deadlines.

## Normal desktop media controls

The MPRIS companion publishes `org.mpris.MediaPlayer2.MusicAssistant` on the
user's session bus. It reports only this device's local helper player, using the
existing authenticated bridge, not the plugin's selected remote speaker.
Metadata and controls participate in the same desktop media selection as browser
video. Existing keyboard shortcuts are not replaced.

The companion follows the player service lifecycle and does not own the audio
process. Its failure must not kill playback. D-Bus properties are cached so the
UI stays responsive while bounded backend requests execute off the main loop.
Unavailable local identity/queue fails closed rather than targeting another
player. A method success indicates the backend accepted the command; playback
state is subsequently read back, not assumed from that return alone.

## Runtime/security

`~/.local/state/music-assistant-player` is private 0700 and persistent; it owns
Chromium profile/SDK localStorage identity, private 0600 bootstrap and Unix socket.
Do not delete profile unless intentionally resetting player identity. Bootstrap
contains a random loopback capability; actual MA config is sent after first-message
WebSocket authentication. Node binds a random IPv4 loopback port, checks exact Host,
rejects non-null origins/websites, and never exposes an HTTP credential endpoint.
Missing/incorrect capability closes the connection. Same-user processes are trusted.

Chromium is isolated/headless with autoplay enabled, **no mute flag, CDP, sandbox
bypass or TLS bypass**. Service process-group cleanup + daemon SIGTERM cleanup own
all browser children. Browser death or missed heartbeat exits nonzero so systemd
restarts. API/Sendspin/health failures reconnect with capped exponential backoff;
SDK identity survives restart. SDK 5.0.0 owns encrypted Sendspin/decoding; product
name is Web Player. Raw ordered Sendspin channel receives no proxy-auth prefix.
DTLS fingerprint verification remains enabled. No LAN/native daemon fallback.

Set `forceRelay:true`, restart and require status transport.localCandidateType
`relay` for production relay verification without CDP. receivedBytes counts the
selected ICE candidate pair; channel.rxBytes counts binary Sendspin payload.

## Verification boundary

Automated tests cover actual loopback/Unix sockets, first-message authentication,
origin rejection, deadlines, CLI subprocesses, configuration privacy, redaction,
reconnect, RPC correlation/bounds, SDK identity and fingerprint checks.
They do not prove headless audio on your laptop, live relay, restricted-user access,
suspend/resume or server-restart behavior. Validate ready + timeSynced, increasing
channel bytes and an uncorked PipeWire output on the intended laptop. Chromium
builds may differ in headless audio behavior. Do not work around problems by
turning off sandbox/TLS validation. Override executable via a systemd user drop-in
`Environment=MA_PLAYER_CHROMIUM=/absolute/path/to/chromium` if needed.
