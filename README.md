# Music Assistant plugin for Omarchy

Talks to a [Music Assistant](https://music-assistant.io/) server over its
JSON-RPC API and exposes a bar widget plus OSD actions, keybindings, and CLI
control.

## Setup

Requires a current Omarchy shell exposing `qs.Ui.KeyboardPanel`. Older shells
without that component cannot load the popup; check that
`/usr/share/omarchy/shell/Ui/KeyboardPanel.qml` exists before installation.

```sh
omarchy plugin add https://github.com/manologarciadev/omarchy.music-assistant.git --enable
```

1. In Music Assistant go to **Settings → Profile** and create a long-lived
   access token.
2. Create `~/.config/music-assistant/` and copy `config.example.json` to
   `~/.config/music-assistant/config.json` (or `$XDG_CONFIG_HOME/music-assistant/config.json`), then
   edit `url` and `token`:
   ```json
   {
     "url": "http://192.168.1.1:8095",
     "token": "eyJhbGciOi...",
     "pollIntervalMs": 2000,
     "preferredPlayerId": "",
     "installMediaKeys": false
   }
   ```
   After saving, restrict permissions since the token grants admin access:

   ```bash
   chmod 600 ~/.config/music-assistant/config.json
   ```
3. The plugin is auto-discovered. Either restart the shell
   (`omarchy restart shell`) or save `~/.config/omarchy/shell.json` after
   adding the widget.

## Optional playback on this device

Requires Python 3.12+, `uv` or `pip`, PortAudio, Python D-Bus/PyGObject
(`python-dbus` / `python-gobject` on Arch), a systemd user session, and working
PipeWire/PulseAudio. Run as the desktop user, not root:

```sh
cd "$HOME/.config/omarchy/plugins/io.github.manologarciadev.music-assistant/local-player"
./install.sh
```

The installer creates a private venv, installs the native Sendspin helper
outside the plugin directory, and registers its user services. From the plugin,
**Players → Play on this device** runs this installer if needed, enables the
helper, and selects this machine. `./install.sh` still does not start playback
by itself. Add these settings to your private config, retaining `token`:

```json
{
  "installMediaKeys": false,
  "localPlayer": {
    "enabled": true,
    "remoteId": "<exact-26-character-remote-ID>",
    "signalingUrl": "wss://signaling.music-assistant.io/ws",
    "name": "This device",
    "forceRelay": false
  }
}
```

Set `installMediaKeys: false` before the first valid config load to avoid the
controller-only bindings. Existing overrides must be removed under
[Media keys](#media-keys). Remote IDs are case-sensitive; `url` is not required
in this mode. With a custom `XDG_CONFIG_HOME`, use the same value in the shell
and systemd user session. Restart the helper after connection settings change.

```sh
omarchy-ma-player start
omarchy-ma-player status   # wait for ready: true
# Optional: start automatically on login
omarchy-ma-player enable
```

**Players → Play on this device** installs the helper if needed, then
starts/selects this machine without transferring or starting another player's
queue. Start/Stop/Restart manage an already-installed helper.
All MA requests use its authenticated remote session, without LAN fallback.
Audio uses native Sendspin over a Music Assistant Remote ID; it does not run
scripts from the MA server. Readiness confirms connectivity, not audible output.

For a reinstall, retain the private config and
`~/.local/state/music-assistant-player/identity.key` to preserve player identity.

## Features

- Live now-playing in the bar with auto-scrolling label
- Popup with 6 tabs: Now (player controls and queue), Players, Search, Favorites, Playlists, Recent
- Transport: play/pause, next/previous, seek (click progress bar)
- Shuffle and repeat (off / all / one) toggles
- Per-player volume slider with mute toggle
- Transfer queue between players with single click
- Search across tracks, albums, artists, playlists, and radio
- Favorites: browse and play liked items, right-click to remove
- Playlists: list user playlists, click to play
- Recent: browse recently played items
- Queue beneath the Now player controls: jump to a track, right-click to remove, or clear the queue
- Polling for live state (2s default interval; HTTP or local helper transport)
- IPC handlers for all actions (see table below)

## Bar widget

Add to the bar layout in `~/.config/omarchy/shell.json`:

```jsonc
{
  "id": "io.github.manologarciadev.music-assistant",
  "section": "right"   // or "left" / "center"
}
```

- Left-click: play / pause the active player
- Middle-click: next track
- Right-click: open popup
- Wheel: previous / next
- Right-click popup tabs:
  - **Now** — now-playing card, transport, volume slider, then the queue
    with click-to-play and right-click-to-remove
  - **Players** — every MA player; click to transfer the current queue,
    right-click to toggle mute
  - **Search** — text search across tracks/albums/artists/playlists, click
    a result to play it on the active player
  - **Favorites** — browse and play liked items; right-click to remove
  - **Playlists** — list user playlists; click to play
  - **Recent** — recently played items

## IPC

The service registers an `IpcHandler` under `target: "io.github.manologarciadev.music-assistant"` so
other shell components (or external scripts) can call it:

### Transport

| Method | Description |
|--------|-------------|
| `status` | JSON snapshot of the active player and connection state |
| `playPause`, `nextTrack`, `previousTrack` | Transport on active player |
| `seek(positionMs)` | Seek to absolute position in current track |
| `seekRelative(deltaMs)` | Seek relative to current position |

### Players

| Method | Description |
|--------|-------------|
| `setVolumePct(percent)` | Set volume 0–100 |
| `power(action)` | `"on"` or `"off"` for the active player |
| `activatePlayerById(playerId)` | Switch active player without transferring queue |
| `transferQueueTo(targetId)` | Transfer the queue from the active player to another |
| `playersList()` | JSON list of every player with playback state |

### Local playback

| Method | Description |
|--------|-------------|
| `localPlayerStatus()` | Helper phase, readiness and safe error status |
| `startLocalPlayer()` / `stopLocalPlayer()` / `restartLocalPlayer()` | Helper lifecycle |
| `playHere()` | Start if needed and select this device |
| `playOnThisDevice()` | Install helper if needed, enable it, then play here |
| `enableLocalPlayer()` / `disableLocalPlayer()` | Enable/disable autostart, not current playback |

Lifecycle calls acknowledge an asynchronous action; check status for readiness.

### Queue & search

| Method | Description |
|--------|-------------|
| `playUri(uri)` / `playUriOn(playerId, uri)` | Play a MA URI |
| `search(query)` | Run a search; results appear in the Search tab |
| `clearQueueNow()` | Clear the active player's queue |
| `saveQueue(name)` | Save current queue as a new playlist |

### Playback mode

| Method | Description |
|--------|-------------|
| `toggleShuffle()` | Toggle shuffle on the active player |
| `cycleRepeat()` | Cycle repeat off → all → one |

### Favorites & library

| Method | Description |
|--------|-------------|
| `favoriteCurrent()` | Add/remove the current track to/from favorites |
| `favoriteAdd(uri)` / `favoriteRemove(uri)` | Add/remove a URI to/from favorites |
| `refreshFavorites()` | Force-refresh favorites from MA |
| `refreshPlaylists()` | Force-refresh playlists from MA |
| `refreshRecent()` | Force-refresh recent items from MA |

### Misc

| Method | Description |
|--------|-------------|
| `refresh()` | Force an immediate state refresh |
| `openWebUI()` | Open the MA web UI in the default browser |

For normal desktop media integration, see [Media keys](#media-keys).

## API commands used

- `players/all` — list of players with current state
- `player_queues/items` — queue listing for the active player
- `players/cmd/volume_set`, `players/cmd/volume_mute`
- `player_queues/play`, `pause`, `play_pause`, `next`, `previous`,
  `play_index`, `delete_item`, `clear`, `transfer`, `play_media`
- `music/search`

See https://music-assistant.io/api/ for full API docs.

## Keyboard shortcuts

When the popup is open:

| Key | Action |
|-----|--------|
| `Escape` | Close popup |
| `Ctrl+1` … `Ctrl+6` | Jump to sidebar tab (Now, Players, Search, Favorites, Playlists, Recent) |
| `Tab` / `Shift+Tab` | Cycle tabs |
| `Space` | Play/pause (Now tab) |
| `↑` / `↓` | Move focus in lists |
| `Enter` | Activate focused item |
| `Delete` | Remove focused item (queue, favorites) |

## Media keys

In controller-only mode, on first successful config load, the plugin auto-installs Hyprland bindings for `XF86AudioPlay`, `XF86AudioPause`, `XF86AudioNext`, and `XF86AudioPrev` so your keyboard media keys control Music Assistant instead of Omarchy's default MPRIS routing. Local-player mode skips this installer and leaves existing bindings untouched.

The block is appended to `~/.config/hypr/bindings.lua` between unique markers (`-- BEGIN music-assistant media-keys` / `-- END music-assistant media-keys`), is fully idempotent (won't duplicate), and runs `hyprctl reload` to activate. Look for `[music-assistant] Media key bindings installed (idempotent)` in the shell log.

### Local-device media source

The managed local player includes an MPRIS companion. It registers **Music
Assistant** as a normal desktop media source with track metadata and
playback controls, alongside browser video and other media applications.
Omarchy's existing source selection and media shortcuts remain in charge—no
exclusive play/pause binding is installed.

The companion resolves the local helper's persistent player identity. It never
uses the speaker selected in the plugin. Selecting a remote speaker therefore
does not expose that speaker through this device's media keys. Stop the local
helper and its MPRIS companion stops with it.

On default Omarchy bindings, Shift+Play/Pause switches media sources. Normal
source-selection rules apply when more than one application is playing.

If an earlier development version installed a block marked
`-- BEGIN music-assistant explicit play-pause`, remove that block through its
matching END marker from `~/.config/hypr/bindings.lua` and run `hyprctl reload`.
Those exclusive bindings and their IPC methods are superseded by MPRIS.

### Opt-out

Add to your `config.json` to disable auto-installation:

```json
{ "installMediaKeys": false }
```

### Manual uninstall

Delete the block between the markers in `~/.config/hypr/bindings.lua` and run `hyprctl reload`.

## Security

### Threat model

This plugin runs unsandboxed as part of the user's Omarchy shell process. It assumes:

- **Local user is trusted.** Any local process can call IPC methods
  (`qs ipc call io.github.manologarciadev.music-assistant playPause`,
  etc.) and trigger Media Assistant actions. There is no authentication
  on the IPC surface. If untrusted local code can run as your user,
  this plugin's actions are not isolated from it.

- **MA server is semi-trusted.** The plugin talks to a Music Assistant
  server URL configured by the user. All responses are validated:
  - Strings are length-bounded (≤500 chars) and `image_url` is
    scheme-whitelisted to `http://`/`https://`.
  - Arrays are size-bounded per collection (≤64 players, ≤2000 queue
    items, ≤50 search hits, etc.).
  - Response body is capped at 8 MB at the transport (`curl
    --max-filesize`).

### What this plugin will not do

- Run any code from the MA server (`JavaScript` URLs in `image_url` are
  dropped).
- Read local files via QML's `Image` type from a compromised MA
  (`file://` URLs are dropped).
- Leak the bearer token into any process's argv or `/proc/PID/cmdline`
  — the token reaches curl via stdin → a 0600-mode temp file → `-H
  @file`, never via `-H "Authorization: ..."` on the command line.

### File permissions

`config.json` is written with `umask 077` and `chmod 600` so the
bearer token is owner-readable only. If you have an existing install
from before this fix, run once:

```sh
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/music-assistant/config.json"
```