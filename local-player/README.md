# Production remote local player

Node 22+, npm, Python 3 stdlib, Chromium, systemd user session, and working
PipeWire/PulseAudio are required. Run as the desktop user, **not root**.

```sh
cd local-player
npm ci
npm run check
./install.sh
```

Installer builds/tests, installs bundles outside the watched plugin tree to
`~/.local/share/omarchy-ma-player`, installs `~/.local/bin/omarchy-ma-player`
and `~/.config/systemd/user/omarchy-ma-player.service`, and reloads systemd.
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
