# Changelog

All notable changes to this plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-08-27

### Security
- Pass MA bearer token via stdin instead of curl `-H` argv (fixes marketplace review finding `BEARER-TOKEN-IN-PROCESS-ARGV`). The token now lives in a 0600-mode `mktemp` file for the duration of one bash invocation only, and never appears in any process's `argv` or `/proc/PID/cmdline`.

## [1.0.0] - 2026-08-26

### Added
- Initial release
- Now-playing display with cover art and progress bar in the bar widget
- Transport controls: play/pause, next, previous, seek (relative and absolute)
- Volume, shuffle, repeat, favorite toggle
- Player selector with queue transfer and right-click mute
- Search across tracks, albums, artists, playlists with type filters
- Favorites tab with filter chips (tracks/albums/artists/playlists/radio)
- Playlists tab with click-to-play
- Recent tab with relative timestamps
- Save queue as playlist from Queue tab
- Auto-install Hyprland media key bindings (`XF86AudioPlay/Pause/Next/Prev`) on first load with markers and idempotency
- Smart media key routing: MPRIS active player first (YouTube, Spotify, etc.), Music Assistant fallback when no other player is active
- Persistent `preferredPlayerId` across shell restarts (saved to `config.json` on player activation)
- IPC handlers for 20+ actions (`status`, `playPause`, `seek`, `setVolumePct`, `toggleShuffle`, `cycleRepeat`, `activatePlayerById`, `playUri`, `playUriOn`, `search`, `clearQueueNow`, `refresh`, `playersList`, `seek`, `seekRelative`, `power`, `favoriteCurrent`, `favoriteAdd`, `favoriteRemove`, `saveQueue`, `openWebUI`, `refreshFavorites`, `refreshPlaylists`, `refreshRecent`)
- Keyboard navigation in popup (`Ctrl+1..7` for tabs, `Tab`/`Shift+Tab` to cycle, `Escape` to close, `Space` play/pause, arrow keys in lists, `Enter` activate, `Delete` remove)
- Configurable polling interval (`pollIntervalMs`), search limit, recent limit, badge display, web UI path, media key install, and MPRIS fallback
- HTTP polling for live state with 2-second default interval

### Notes
- Plugin id: `io.github.manologarciadev.music-assistant`
- License: MIT
- Tested on Quickshell-git, Omarchy (Quattro)