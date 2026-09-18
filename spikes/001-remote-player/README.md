# Remote local-player experiment

## Scope and verdict: VALIDATED transport, PARTIAL product integration

This is an isolated feasibility experiment, **not yet a plugin-managed player**.
It reproduces Music Assistant's remote web-player path without a native Sendspin
LAN daemon or a connection to server port 8927:

1. Connect to public signaling using a Music Assistant remote ID.
2. Verify the server's DTLS certificate against that ID (never bypass verification).
3. Authenticate the `ma-api` WebRTC data channel using the MA access token.
4. Open an ordered `sendspin` data channel on the same peer connection.
5. Adopt it in the official browser SDK, which owns Noise, pairing identity,
   decoding, synchronization and Web Audio output.
6. Call `sendspin/pair_web_player` through the authenticated API.
7. Require the exact local player's `players/get` response to report availability.

No direct HTTP/WebSocket MA fallback is implemented. A second proxy auth envelope
must NOT be sent on the raw Sendspin data channel.

## Source baseline

- Music Assistant server 2.10.3: `3e21f8293fbcd8710dc2d3c8afc2c94418187cf9`
- Pinned frontend 2.17.297: `e779b9d359e47cd210c2801f16a0ce6263571903`
- `@sendspin/sendspin-js` 5.0.0 (exact npm dependency and lockfile)
- Frontend transport code is vendored unchanged; see [NOTICE.md](NOTICE.md).

## Build and tests

```sh
npm ci
npm run check
```

Twenty tests cover RPC correlation/partial responses/errors, redacted diagnostics,
channel adaptation, ordering of authentication/pairing/readiness, cancellation,
identity persistence, actual SDK `client/init`, and DTLS fingerprint verification.
Most orchestration tests use fake transports; they are not network proof.

## Private bootstrap

The browser expects `window.MA_SPIKE_CONFIG` before loading `dist/spike.js`:

```js
window.MA_SPIKE_CONFIG = {
  token: "<MA access token>",
  remoteId: "<MA remote ID>",
  signalingUrl: "wss://signaling.music-assistant.io/ws"
};
```

Put this only in a private, owner-readable HTML file outside the repository and
Omarchy's watched plugin tree. Never commit a rendered page. Use an isolated,
owner-only Chromium profile; its storage holds the persistent identity and pairing
keys. The page removes the global config after consuming it. `file://` was tested;
no local HTTP credential endpoint is needed. Source bundle console calls are
stripped because upstream transport logging can include connection metadata.

Start Chromium with that private file. Click **Connect local player** to unlock
audio, connect and pair. An automated test may use Chromium's autoplay-policy
flag in its isolated profile. Do not disable certificate validation, origin
security or the browser sandbox. The experiment exposes `window.maSpike` for
local automation: `connect`, `status`, `rpc`, `disconnect`, and `playerId`.
Only `status` is a redacted diagnostics interface; arbitrary RPC results can be
sensitive. CDP is for the test harness only, not a production control interface.

## Live results (2026-09-18)

Executed on Linux with Chromium 152 and PipeWire, against MA 2.10.3 with built-in
remote access enabled through Home Assistant Cloud:

- Authenticated API channel, encrypted Sendspin handshake and automatic pairing
  all succeeded. The exact local player became available and time-synchronized.
- Disconnect/reconnect preserved the SDK-generated player identity.
- A second connection forced `iceTransportPolicy: "relay"` in the test harness.
  `getStats()` confirmed a selected **relay** local candidate, **srflx** remote
  candidate, UDP and a successful selected pair. This prevents a direct same-LAN
  ICE candidate from passing the test accidentally. Certificate checks stayed on.
- MA fetched the public `anars/blank-audio` ten-second silence MP3 and played it
  only to the experimental local player. The client reported `playing: true`,
  `codec: opus`, `timeSynced: true`; binary receive traffic increased.
- PipeWire/Pulse reported Chromium's playback stream uncorked, stereo float32
  at 48 kHz, attached to the laptop's default speaker output.
- The test used silence: decoder/output-path operation was verified, not human
  assessment of audible music quality or synchronization with other speakers.

The remote API and audio path are therefore validated through TURN, rather than
merely reaching the server over its LAN listener. No router, server configuration,
other player queues, or Quickshell files were changed by the experiment.

## Remaining before product integration

- Private process/IPC lifecycle managed by the plugin, without CDP in production.
- Start/stop and explicit Play Here/Transfer Here controls in QML.
- Remote credentials and pairing storage UX; adopt the associated API session for
  private web-player visibility/control rather than assuming HTTP polling sees it.
- Reconnect/backoff, network changes, suspend/resume, autostart and cleanup.
- Audio output choice, audible music test, latency and multi-room synchronization.
- Limited-user permission checks over WebRTC (upstream session association differs
  from the direct proxy), expired tokens and server restart tests.
- Integrate without putting runtime state inside the plugin source tree.

Adopted SDK sockets do not automatically reconnect; this experiment requires an
explicit reconnect. It intentionally has no always-on installed service.
