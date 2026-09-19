# Integration verification

## Status: installed and ready for user acceptance testing

The managed helper and plugin integration passed the live checks below. This
development branch is ready for audible playback and normal interactive testing;
this is not a long-term reliability guarantee.

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

### Stability recheck and remaining limits

During an unstable connection, an idle soak observed a `HEALTH_FAILED` reconnect.
The persistent diagnostic identified `players-get` / `RPC_TIMEOUT` after 10,001 ms.
Automatic reconnection recovered. After the user reported that connectivity had
been unstable and requested a retry, a fresh 185.2-second soak passed all 90
readiness samples with no new health failures. Playback/output and plugin
start/stop/Play here/switching tests then passed again, with an unchanged shell
PID and no new crash reports. No timeouts were widened to hide the failure.

The exact network cause was not independently established. Signaling rate limits
also occurred during earlier rapid restart experiments; avoid restart storms.
Safe `lastHealthFailure` diagnostics remain available across reconnects.

Final checks confirmed config mode 0600, runtime-state mode 0700, enabled
autostart, closed temporary debug port, and installed QML/runtime artifact hashes
matching the tested source/build. Automated checks passed: 48 plugin tests,
51 TypeScript runtime tests, 4 Python tests, typecheck and build.

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
