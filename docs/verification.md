# Integration verification

## Status: implemented, stability investigation still open

The managed helper and plugin integration are **not yet signed off as ready for
normal use**. This development branch contains the tested implementation and
safe health diagnostics, not a reliability guarantee.

### Verified on the target laptop

- Separate systemd-user-managed Chromium audio runtime; stable SDK identity.
- Authenticated remote-ID WebRTC, Sendspin pairing, available local player.
- Forced TURN relay with the hardened runtime; Opus decoding and uncorked
  48 kHz stereo PipeWire output using a silent test track.
- Volume, mute, pause/resume, seek, shuffle/repeat and library browsing.
- Native QML service loading, plugin start/stop/Play here, repeated IPC player
  selection, and saved selection persistence without new shell crash reports.
- Browser-kill recovery, identity reuse, shutdown without orphan browser
  processes and enabled user-service autostart.
- Existing media-key configuration preserved.
- Source/specification and independent quality reviews passed, including
  cancellation isolation, bounded chunk assembly and diagnostic redaction.

### Unresolved / not verified

A three-minute idle soak observed one `HEALTH_FAILED` reconnect. The connection
recovered, but the cause is not established. The status now retains a sanitized
`lastHealthFailure` (stage, bounded elapsed milliseconds, safe code and relevant
booleans) across reconnect to distinguish API, player-state and statistics
failures. No timeout/reconnect behavior has been changed to conceal failures.

Signaling rate-limit errors occurred during earlier repeated connection testing.
SSH connectivity also became intermittent; that correlation alone does not prove
the playback issue is a network fault. Further investigation requires stable
access to the laptop.

Normal `forceRelay:false` settings were restored after successful relay testing.
Temporary browser-debug settings were removed. The diagnostic build uses the
normal protected status interface, not a browser debug port.

Human listening quality, actual popup mouse-click paths, physical suspend/resume,
server restart and restricted-user permissions remain outside the completed
checks. Silence proves decoding/output, not audible fidelity.

### Reproduce automated checks

```sh
node --test tests/*.test.cjs
cd local-player
npm ci
npm run check
```

Do not infer live reliability from the unit-test count or a successful build.
