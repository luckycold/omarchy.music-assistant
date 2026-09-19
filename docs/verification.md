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
- Normal Omarchy media bindings restored after removing the superseded exclusive
  MA override; real browser MediaSession play/pause verified through Linux input events.
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

### Popup regression verification

The initial IPC-only checks missed two UI defects: PopupCard did not provide
reliable compositor keyboard focus, and library refresh was wired only to popup
opening, not sidebar selection. The widget now uses the installed shell's
`qs.Ui.KeyboardPanel` with an explicit focus target, and refreshes library data
on section changes/open/reconnection. This requires a shell exposing KeyboardPanel.

An isolated native harness loaded the actual BarWidget and Service against the
laptop's shared Ui/Commons modules, with a keyboard-unfocused parent bar. Actual
Wayland keystrokes entered the search field, Enter submitted a real search,
Escape closed the panel, and three close/reopen cycles retained keyboard input.
Tab activation loaded the server's one favorite track and 39 playlists without
closing/reopening the panel. The corrected installed widget's hash matched the
tested source; the live shell and separate player remained connected. All 56
plugin regression tests passed, including eight new popup tests.

### Local-device MPRIS integration — corrected build acceptance passed

Independent review found a local-group-leader isolation gap and MPRIS interface
gaps in the initial build. These are corrected and the full real-player/browser
coexistence test passed again on the installed, hash-verified corrected adapter.
Final independent re-review passed with no blocking findings; all 25 targeted
MPRIS tests passed independently. The full Python suite additionally includes
four CLI tests. The player was stopped before the final deployment test, so it
was returned to that state afterward; starting it also starts its MPRIS companion.

A separate native D-Bus contract test, run under an isolated `dbus-run-session`
with an explicitly simulated backend, verified Volume read/write and NaN
rejection, paused CanPause, external-position Seeked emission, and hiding a local
group leader with remote members. Real server tests separately verified actual
laptop volume write/readback and restored its original volume. No real speakers
were grouped or regrouped for testing.

The earlier exclusive MA play/pause override was removed because it prevented
normal browser media control. Normal Omarchy bindings were reloaded and their
play/pause behavior verified using a real Chromium video/MediaSession with silent
audio and Linux input events. The temporary browser and keyboard were removed.

The replacement companion is installed and registered as
`org.mpris.MediaPlayer2.MusicAssistant`, with identity **Music Assistant (Laptop)**.
Its files and systemd dependency configuration were read back. Live tests passed:

- Local track metadata is available through real D-Bus properties.
- With a different remote speaker selected in the plugin, MPRIS Play starts only
  the laptop; the remote speaker's playback state is unchanged.
- Normal, unmodified Omarchy media keys pause/resume the laptop through MPRIS.
- A genuine Chromium video/MediaSession then receives the same keys while MA
  remains idle; no exclusive routing or fallback shortcut is installed.
- Stopping the MPRIS companion removes the media source without stopping or
  restarting the audio helper; restarting re-registers the source.
- Queue size, original mute/playback state and plugin selection were restored.
  Temporary test browser and Linux input device were removed.
- Obsolete exclusive IPC handlers were removed from the installed plugin and
  verified absent after a controlled shell restart; the MPRIS source remained.

The companion is bound to the helper's local identity and deliberately refuses
redirected/group queue IDs. It never follows the plugin's selected remote player.
Automated checks passed: 60 plugin tests, 51 runtime TypeScript tests, 19 Python
tests in the initial build, then 29 Python tests after hardening; typecheck and
build also passed. The browser coexistence fixture exercises the same
MediaSession/MPRIS path used by browser video; it is not an actual YouTube-site test.

The local protocol lacks native pause support: MA's queue pause saves resume
position and stops the stream, reporting `idle` rather than `paused`. Tests must
check non-playing followed by successful resume, not demand a literal paused
state. Existing queue, mute, playback state and plugin selection must be preserved.

### Reproduce automated checks

```sh
node --test tests/*.test.cjs
cd local-player
npm ci
npm run check
```

Do not infer live reliability from the unit-test count or a successful build.

## Adaptive media layout — 2026-09-19

The native MPRIS widget was cloned through Omarchy's supported user-local clone
command; no system Bar.qml or global media bindings were edited. Its service
lookup uses its injected clone id. Both widgets share the same visual-slot
allocator. The plugin now passes 76 root tests; the unchanged runtime passes
51 TypeScript and 29 Python tests plus typecheck/build.

Parent native checks on three active screens verified the laptop's two widget
widths at 475/320 logical pixels and external widths at 1090/880. Fixed clock and
controls did not overlap; inter-group gaps measured 7–8px after integer geometry
rounding. An isolated native QML fixture with synthetic metadata also passed
long-to-short marquee reset, live resize, artist-only media, filling toggles,
and hide/reappear checks with clean logs. Its initial artist-only failure drove
a visibility correction in the native-widget bootstrap. Disabling filling returned both widgets to their old bounded widths;
reenabling restored the allocations. Temporary settings were removed afterward.
Full-width laptop/external bar captures were inspected. The current shell log
contained no layout/plugin binding errors (unrelated existing omaconnect warnings
remain). JavaScript adapter tests separately exercise empty/hidden slots, lane
allocation, missing anchors, and poisoned flexible-geometry getters.

Layout changes do not start, stop, or redirect playback. Exact widths depend on
visible workspaces/indicators. The installer and safe upstream-drift/idempotence
checks are versioned in the dotfiles bootstrap rather than private runtime config.
