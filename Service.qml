import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Mpris
import qs.Commons
import "MaApi.js" as MaApi
import "ConfigSchema.js" as ConfigSchema

Item {
  id: root

  property var shell: null

  // --------------------------------------------------------------- config
  property var config: ({})
  property string configError: ""
  property bool ready: false

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string pluginId: "io.github.manologarciadev.music-assistant"
  readonly property string configPath: home + "/.config/omarchy/plugins/" + pluginId + "/config.json"

  // ---------------------------------------------------------------- state
  property var players: []
  property string activePlayerId: ""
  property var queue: []
  property int queuePosition: 0
  property int queueRevision: 0
  property var searchResults: null
  property string searchQuery: ""
  property string lastError: ""
  property bool connected: false
  property int revision: 0

  // --------------------------------------------------------------- mpris
  readonly property var mprisPlayers: Mpris.players ? Mpris.players.values : []
  readonly property var activeMprisPlayer: root.pickActiveMprisPlayer()

  function pickActiveMprisPlayer() {
    var oldest = null
    var oldestOrder = 0
    var playingProxy = null
    var proxyOrder = 0
    for (var i = 0; i < root.mprisPlayers.length; i++) {
      var p = root.mprisPlayers[i]
      if (!p || !p.isPlaying) continue
      var dbusName = String(p.dbusName || "").toLowerCase()
      var isProxy = dbusName.indexOf("playerctld") !== -1
      var order = i + 1000
      if (!isProxy && (!oldest || order < oldestOrder)) {
        oldest = p
        oldestOrder = order
      } else if (isProxy && (!playingProxy || order < proxyOrder)) {
        playingProxy = p
        proxyOrder = order
      }
    }
    return oldest || playingProxy || null
  }

  function mprisRoutingEnabled() {
    return root.config && root.config.mprisFallback !== false
  }
  property string preferredPlayerId: ""
  property var favorites: ({ tracks: [], albums: [], artists: [], playlists: [], radio: [] })
  property int favoritesRevision: 0
  property var _favTypes: []
  property int _favIndex: 0
  property var playlists: []
  property int playlistsRevision: 0
  property var recentItems: []
  property int recentRevision: 0

  readonly property int pollIntervalMs: {
    var v = config && config.pollIntervalMs ? config.pollIntervalMs : 2000
    return Math.max(500, v)
  }

  readonly property var activePlayer: {
    if (!players || players.length === 0) return null
    for (var i = 0; i < players.length; i++) {
      if (players[i].player_id === activePlayerId) return players[i]
    }
    return null
  }

  readonly property var activeMedia: {
    var p = activePlayer
    return p && p.current_media ? p.current_media : null
  }

  readonly property bool hasMedia: activeMedia !== null && (activeMedia.title || activeMedia.uri)

  readonly property bool isPlaying: MaApi.isPlaying(activePlayer)
  readonly property bool isPaused: MaApi.isPaused(activePlayer)
  readonly property int activeVolume: MaApi.volumePercent(activePlayer)
  readonly property string activeTitle: MaApi.trackTitle(activeMedia)
  readonly property string activeArtist: MaApi.trackArtist(activeMedia)
  readonly property string activeAlbum: MaApi.trackAlbum(activeMedia)
  readonly property string activeImageUrl: MaApi.trackImageUrl(activeMedia)
  readonly property int activeDuration: activeMedia && activeMedia.duration ? activeMedia.duration : 0
  readonly property int activeElapsed: activeMedia && activeMedia.elapsed_time ? activeMedia.elapsed_time : 0

  // ---------------------------------------------------------------- config loader

  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    printErrors: false
    onLoaded: root.applyConfig(text())
    onFileChanged: root.applyConfig(text())
    onLoadFailed: function(err) {
      root.configError = "config.json missing or unreadable"
      root.config = ({})
      root.ready = false
    }
  }

  Component.onCompleted: {
    if (configFile) configFile.reload()
    Qt.callLater(function() {
      installMediaKeysBindings()
    })
  }

  // --------------------------------------------------- media keys installer

  readonly property string mediaKeysMarkerBegin: "-- BEGIN music-assistant media-keys"
  readonly property string mediaKeysMarkerEnd: "-- END music-assistant media-keys"
  readonly property string ipcTarget: root.pluginId

  function mediaKeysBindingsBlock() {
    var qsBin = "/usr/bin/qs"
    var omarchyShell = (Quickshell.env("OMARCHY_PATH") || "/usr/share/omarchy") + "/shell"
    var ipcCmd = qsBin + " -p " + omarchyShell + " ipc call " + root.pluginId
    return [
      "",
      mediaKeysMarkerBegin,
      "hl.unbind(\"XF86AudioNext\")",
      "hl.unbind(\"XF86AudioPrev\")",
      "hl.unbind(\"XF86AudioPlay\")",
      "hl.unbind(\"XF86AudioPause\")",
      "o.bind(\"XF86AudioNext\", \"Music next\", \"" + ipcCmd + " nextTrack\", { locked = true })",
      "o.bind(\"XF86AudioPrev\", \"Music previous\", \"" + ipcCmd + " previousTrack\", { locked = true })",
      "o.bind(\"XF86AudioPlay\", \"Music play/pause\", \"" + ipcCmd + " playPause\", { locked = true })",
      "o.bind(\"XF86AudioPause\", \"Music play/pause\", \"" + ipcCmd + " playPause\", { locked = true })",
      mediaKeysMarkerEnd,
      ""
    ].join("\n")
  }

  function installMediaKeysBindings() {
    if (!root.ready) return
    if (root.config && root.config.installMediaKeys === false) return

    mediaKeysInstaller.running = true
  }

  readonly property string mediaKeysInstallScript: {
    var hyprConfig = Quickshell.env("HOME") + "/.config/hypr/bindings.lua"
    var block = root.mediaKeysBindingsBlock().replace(/'/g, "'\\''")
    return "set -e\n" +
      "F=\"" + hyprConfig + "\"\n" +
      "if [ ! -f \"$F\" ]; then exit 0; fi\n" +
      "if grep -qF -e '" + root.mediaKeysMarkerBegin + "' \"$F\"; then exit 0; fi\n" +
      "touch \"$F\"\n" +
      "if [ -s \"$F\" ] && [ -n \"$(tail -c 1 \"$F\")\" ]; then echo >> \"$F\"; fi\n" +
      "printf '%s\\n' '" + block + "' >> \"$F\"\n" +
      "hyprctl reload >/dev/null 2>&1 || true\n"
  }

  Process {
    id: mediaKeysInstaller
    command: [Quickshell.env("SHELL") || "/bin/bash", "-c", root.mediaKeysInstallScript]
    onExited: function(exitCode) {
      if (exitCode === 0) {
        console.log("[music-assistant] Media key bindings installed (idempotent)")
      } else {
        console.warn("[music-assistant] Failed to install media key bindings: exitCode=" + exitCode)
      }
    }
  }

  // --------------------------------------------------- config persistence

  Process {
    id: configSaver
    property string savePath: ""
    property string saveJson: ""
    onExited: function(exitCode) {
      if (exitCode === 0) {
        console.log("[music-assistant] Config persisted to " + savePath)
      } else {
        console.warn("[music-assistant] Failed to persist config (exit=" + exitCode + ")")
      }
    }
  }

  function configSaveScript(path, json) {
    var safePath = path.replace(/'/g, "'\\''")
    var safeJson = json.replace(/'/g, "'\\''")
    return "set -e\n" +
      "F='" + safePath + "'\n" +
      "T=\"$F.tmp.$$\"\n" +
      "printf '%s\\n' '" + safeJson + "' > \"$T\"\n" +
      "mv -f \"$T\" \"$F\"\n"
  }

  function persistConfig() {
    if (!root.ready || !root.config) return
    var path = root.configPath
    var json = JSON.stringify(root.config, null, 2)
    configSaver.savePath = path
    configSaver.saveJson = json
    configSaver.command = [Quickshell.env("SHELL") || "/bin/bash", "-c",
      root.configSaveScript(path, json)]
    configSaver.running = true
  }

  function applyConfig(text) {
    var result = ConfigSchema.parse(text)
    root.config = result.config
    root.preferredPlayerId = result.config.preferredPlayerId || ""
    root.ready = result.error.length === 0
    root.configError = result.error
    if (root.ready) {
      root.startConnection()
      Qt.callLater(function() { root.installMediaKeysBindings() })
    } else {
      root.stopConnection()
      root.configError = result.error || "invalid config"
    }
  }

  // --------------------------------------------------------------- polling

  property bool pollingActive: false
  property bool pollInFlight: false
  property bool shuffleEnabled: false
  property string repeatMode: "off"
  property int elapsed: 0
  property int duration: 0
  property var _lastSuccessAt: 0

  Timer {
    id: pollTimer
    interval: root.config && root.config.pollIntervalMs ? root.config.pollIntervalMs : 2000
    repeat: true
    running: root.ready
    triggeredOnStart: true
    onTriggered: root.refreshState()
  }

  function startConnection() {
    root.pollingActive = true
    pollTimer.restart()
  }

  function stopConnection() {
    pollTimer.stop()
    root.pollingActive = false
  }

  function refreshState() {
    if (!root.ready) return
    if (root.pollInFlight) return
    root.pollInFlight = true
    root.runFetchPlayers()
  }

  function refreshIfStale(maxAgeMs) {
    if (!root.ready) return
    var age = Date.now() - (root._lastSuccessAt || 0)
    if (age < maxAgeMs) return
    root.refreshState()
  }

  function runFetchPlayers() {
    if (!root.ready) { root.pollInFlight = false; return }
    var args = MaApi.buildArgs(root.config.url, root.config.token, "players/all", {}, "poll-players")
    playersProc.command = args
    playersProc.running = true
  }

  function runFetchQueue(playerId) {
    if (!root.ready || !playerId) { root.pollInFlight = false; return }
    var args = MaApi.buildArgs(root.config.url, root.config.token,
      "player_queues/items",
      { queue_id: playerId, limit: 200, offset: 0 },
      "poll-queue")
    queueProc.command = args
    queueProc.running = true
  }

  Process {
    id: playersProc
    property string outputText: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var text = playersProc.stdout.text
        try {
          var payload = JSON.parse(String(text || "{}"))
          root.applyPlayers(payload.result || payload)
        } catch (e) {
          root.lastError = "players parse: " + e.message
        }
        var chosen = root.pickNextActivePlayer()
        if (chosen && chosen !== root.activePlayerId) {
          root.activePlayerId = chosen
        }
        root.runFetchQueue(root.activePlayerId)
      }
    }
    onExited: {
      if (root.pollInFlight && root.lastError === "") {
        // queue fetch will reset pollInFlight
      } else if (root.pollInFlight) {
        root.pollInFlight = false
      }
    }
  }

  Process {
    id: queueProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var payload = JSON.parse(String(queueProc.stdout.text || "{}"))
          root.applyQueue(payload.result || payload)
        } catch (e) {
          root.lastError = "queue parse: " + e.message
        }
        root.pollInFlight = false
      }
    }
  }

  function applyPlayers(list) {
    if (!Array.isArray(list)) {
      root.lastError = "players/all returned non-list"
      return
    }
    root.players = list
    root.revision = root.revision + 1
    root.connected = true
    root._lastSuccessAt = Date.now()
    root.lastError = ""
    root.updatePlayModeFromPlayer()
  }

  function applyQueue(payload) {
    if (!payload) {
      root.queue = []
      root.queuePosition = 0
      return
    }
    var items = Array.isArray(payload) ? payload : (payload.items || [])
    var pos = (payload && payload.current_item_index !== undefined) ? payload.current_item_index
      : (payload && payload.current_index !== undefined) ? payload.current_index
      : 0
    root.queue = items
    root.queuePosition = pos || 0
    root.queueRevision = root.queueRevision + 1
  }

  function pickNextActivePlayer() {
    return MaApi.pickActivePlayerId(root.players, root.preferredPlayerId)
  }

  function refreshPlayersOnly() {
    if (!root.ready) return
    var args = MaApi.buildArgs(root.config.url, root.config.token, "players/all", {}, "ws-players")
    playersProc.command = args
    playersProc.running = true
  }

  function updatePlayModeFromPlayer() {
    var p = root.activePlayer
    if (!p) return
    if (p.shuffle_enabled !== undefined) root.shuffleEnabled = !!p.shuffle_enabled
    if (p.repeat_mode !== undefined) root.repeatMode = String(p.repeat_mode)
  }

  // ------------------------------------------------------------- helpers

  function playerById(id) {
    if (!players || !id) return null
    for (var i = 0; i < players.length; i++) {
      if (players[i].player_id === id) return players[i]
    }
    return null
  }

  function showOsd(actionLabel, iconName, message) {
    if (!shell) return
    shell.summon("omarchy.osd", JSON.stringify({
      icon: iconName || "media",
      message: message || actionLabel
    }))
  }

  // ----------------------------------------------------------- action api

  function runAction(command, args, onDone) {
    if (!root.ready) return
    var argv = MaApi.buildPlayArgs(root.config.url, root.config.token, command, args)
    actionProc.command = argv
    actionProc.onFinished = onDone || null
    actionProc.actionCommand = command
    actionProc.running = true
  }

  Process {
    id: actionProc
    property var onFinished: null
    property string actionCommand: ""
    onExited: function(code, status) {
      if (root.actionOnExited) root.actionOnExited(code, status)
      if (typeof onFinished === "function") onFinished(code, status)
      // schedule a quick refresh so UI picks up the new state
      if (refreshTimer) refreshTimer.restart()
    }
  }

  property var actionOnExited: null

  Timer {
    id: refreshTimer
    interval: 250
    repeat: false
    onTriggered: root.refreshState()
  }

  function actionForPlayer(playerId, command, args) {
    var pid = playerId || root.activePlayerId
    var a = args ? Object.assign({}, args) : {}
    a.queue_id = pid
    root.runAction(command, a)
  }

  function actionForSourceTarget(command, args) {
    root.runAction(command, args)
  }

  function playPause(playerId) {
    if (root.mprisRoutingEnabled() && root.activeMprisPlayer) {
      var mp = root.activeMprisPlayer
      if (mp.isPlaying && mp.canPause) mp.pause()
      else if (mp.canPlay) mp.play()
      else if (mp.canTogglePlaying) mp.togglePlaying()
      return
    }
    if (!root.activePlayer && !playerId) return
    var pid = playerId || root.activePlayerId
    var isP = MaApi.isPlaying(root.playerById(pid))
    if (isP) {
      root.actionForPlayer(pid, "player_queues/pause")
    } else {
      root.actionForPlayer(pid, "player_queues/play")
    }
    root.showOsd(isP ? "Pause" : "Play", isP ? "media-pause" : "media-play",
      (MaApi.trackTitle(root.playerById(pid).current_media) || "Music Assistant"))
  }

  function next(playerId) {
    if (root.mprisRoutingEnabled() && root.activeMprisPlayer) {
      if (root.activeMprisPlayer.canGoNext) root.activeMprisPlayer.next()
      return
    }
    root.actionForPlayer(playerId, "player_queues/next")
    root.showOsd("Next", "media-next", MaApi.trackTitle(root.playerById(playerId || root.activePlayerId).current_media))
  }

  function previous(playerId) {
    if (root.mprisRoutingEnabled() && root.activeMprisPlayer) {
      if (root.activeMprisPlayer.canGoPrevious) root.activeMprisPlayer.previous()
      return
    }
    root.actionForPlayer(playerId, "player_queues/previous")
    root.showOsd("Previous", "media-previous", MaApi.trackTitle(root.playerById(playerId || root.activePlayerId).current_media))
  }

  function play(playerId) {
    root.actionForPlayer(playerId, "player_queues/play")
  }

  function pause(playerId) {
    root.actionForPlayer(playerId, "player_queues/pause")
  }

  function setVolume(playerId, volumePercent) {
    var pid = playerId || root.activePlayerId
    var v = Math.max(0, Math.min(100, Math.round(volumePercent)))
    root.actionForPlayer(pid, "players/cmd/volume_set", { volume_level: v })
  }

  function setMuted(playerId, muted) {
    var pid = playerId || root.activePlayerId
    root.actionForPlayer(pid, "players/cmd/volume_mute", { muted: !!muted })
  }

  function toggleMute(playerId) {
    var pid = playerId || root.activePlayerId
    var p = root.playerById(pid)
    root.setMuted(pid, !(p && p.volume_muted))
  }

  function transferQueue(sourceId, targetId) {
    root.runAction("player_queues/transfer", {
      source_queue_id: sourceId || root.activePlayerId,
      target_queue_id: targetId,
      auto_play: true
    })
    root.preferredPlayerId = targetId
    root.activePlayerId = targetId
    if (root.config) {
      root.config.preferredPlayerId = targetId
      root.persistConfig()
    }
    root.refreshState()
  }

  function activatePlayer(playerId) {
    if (!root.playerById(playerId)) return
    root.preferredPlayerId = playerId
    root.activePlayerId = playerId
    if (root.config) {
      root.config.preferredPlayerId = playerId
      root.persistConfig()
    }
    root.refreshState()
  }

  function playUri(playerId, uri) {
    if (!uri) return
    root.actionForPlayer(playerId, "player_queues/play_media", {
      media: uri,
      option: "play"
    })
    root.refreshState()
  }

  function playIndex(playerId, index) {
    root.actionForPlayer(playerId, "player_queues/play_index", { index: index })
    root.refreshState()
  }

  function deleteQueueItem(playerId, itemId) {
    root.actionForPlayer(playerId, "player_queues/delete_item", { queue_item_id: itemId })
    root.refreshState()
  }

  function clearQueue(playerId) {
    root.actionForPlayer(playerId, "player_queues/clear")
    root.refreshState()
  }

  function search(query, limit) {
    if (!query) return
    root.searchQuery = query
    var lim = limit || 20
    var argv = MaApi.buildArgs(root.config.url, root.config.token,
      "music/search",
      { search_query: query, limit: lim, media_types: ["track", "album", "artist", "playlist"] },
      "search-" + Date.now())
    searchProc.command = argv
    searchProc.running = true
  }

  function clearSearch() {
    root.searchResults = null
    root.searchQuery = ""
  }

  Process {
    id: searchProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var payload = JSON.parse(String(searchProc.stdout.text || "{}"))
          root.searchResults = payload.result || payload
          root.searchRevision = root.searchRevision + 1
        } catch (e) {
          root.lastError = "search parse: " + e.message
        }
      }
    }
  }

  Process {
    id: favProc
    property string typeKey: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var payload = JSON.parse(String(favProc.stdout.text || "{}"))
          var list = payload.result || payload || []
          var next = Object.assign({}, root.favorites)
          next[favProc.typeKey] = Array.isArray(list) ? list : []
          root.favorites = next
          root.favoritesRevision = root.favoritesRevision + 1
        } catch (e) {
          root.lastError = "favorites parse: " + e.message
        }
        root._favFetchNext()
      }
    }
  }

  Process {
    id: playlistsProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var payload = JSON.parse(String(playlistsProc.stdout.text || "{}"))
          root.playlists = Array.isArray(payload.result) ? payload.result : (Array.isArray(payload) ? payload : [])
          root.playlistsRevision = root.playlistsRevision + 1
        } catch (e) {
          root.lastError = "playlists parse: " + e.message
        }
      }
    }
  }

  Process {
    id: recentProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var payload = JSON.parse(String(recentProc.stdout.text || "{}"))
          root.recentItems = Array.isArray(payload.result) ? payload.result : []
          root.recentRevision = root.recentRevision + 1
        } catch (e) {
          root.lastError = "recent parse: " + e.message
        }
      }
    }
  }

  Process {
    id: saveQueueProc
    property string phase: ""
    property string name: ""
    property string newPlaylistId: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (saveQueueProc.phase !== "create") {
          root.saveQueuePhase = ""
          root.saveQueueNewId = ""
          root.refreshPlaylists()
          return
        }
        try {
          var payload = JSON.parse(String(saveQueueProc.stdout.text || "{}"))
          var res = payload.result || payload
          var pid = res && res.item_id ? res.item_id : (res && res.uri ? res.uri.split("/").pop() : "")
          if (!pid) {
            root.saveQueuePhase = ""
            return
          }
          root.saveQueueNewId = pid
          var items = root.queue.map(function(it) { return it.uri || it.media_item_uri || "" }).filter(function(u) { return u.length > 0 })
          saveQueueProc.phase = "add"
          var argv = MaApi.buildArgs(root.config.url, root.config.token,
            "music/playlists/add_playlist_tracks", { playlist_id: pid, tracks: items },
            "save-q-add")
          saveQueueProc.command = argv
          saveQueueProc.running = true
        } catch (e) {
          root.lastError = "save queue parse: " + e.message
          root.saveQueuePhase = ""
        }
      }
    }
  }

  property string saveQueuePhase: ""
  property string saveQueueNewId: ""

  property int searchRevision: 0

  function seek(playerId, positionMs) {
    var pid = playerId || root.activePlayerId
    if (!pid) return
    var p = Math.max(0, Math.round(positionMs))
    root.actionForPlayer(pid, "player_queues/seek", { position_ms: p })
  }

  function seekRelative(deltaMs) {
    var cur = root.activeMedia ? (root.activeMedia.elapsed_time || 0) : 0
    root.seek(root.activePlayerId, cur + deltaMs)
  }

  function toggleShuffle(playerId) {
    var pid = playerId || root.activePlayerId
    var p = root.playerById(pid)
    if (!p) return
    var next = !(p.shuffle_enabled === true)
    root.actionForPlayer(pid, "player_queues/shuffle", { shuffle_enabled: next })
    root.shuffleEnabled = next
  }

  function cycleRepeat(playerId) {
    var pid = playerId || root.activePlayerId
    var p = root.playerById(pid)
    var cur = p && p.repeat_mode ? String(p.repeat_mode) : "off"
    var next = cur === "off" ? "all" : (cur === "all" ? "one" : "off")
    root.actionForPlayer(pid, "player_queues/repeat", { repeat_mode: next })
    root.repeatMode = next
  }

  function power(playerId, on) {
    var pid = playerId || root.activePlayerId
    root.actionForPlayer(pid, "players/cmd/power", { powered: !!on })
  }

  function addFavorite(uri) {
    if (!uri) return
    root.actionForSourceTarget("music/favorites/add_item", { item: uri })
    root.refreshFavorites()
  }

  function removeFavorite(uri) {
    if (!uri) return
    root.actionForSourceTarget("music/favorites/remove_item", { item: uri })
    root.refreshFavorites()
  }

  function favoriteCurrent() {
    var m = root.activeMedia
    if (!m || !m.uri) return
    root.addFavorite(m.uri)
    root.showOsd("Favorited", "favorite", MaApi.trackTitle(m))
  }

  function openWebUI() {
    if (!shell) return
    var url = root.config.openWebUiPath && root.config.openWebUiPath.length > 0
      ? root.config.openWebUiPath : root.config.url
    shell.summon("browser", url)
  }

  function refreshFavorites() {
    if (!root.ready) return
    root._favTypes = ["tracks", "albums", "artists", "playlists", "radio"]
    root._favIndex = 0
    root._favFetchNext()
  }

  function _favFetchNext() {
    if (root._favIndex >= root._favTypes.length) return
    var t = root._favTypes[root._favIndex++]
    var argv = MaApi.buildArgs(root.config.url, root.config.token,
      "music/favorites/" + t, { limit: 50 }, "fav-" + t)
    favProc.typeKey = t
    favProc.command = argv
    favProc.running = true
  }

  function refreshPlaylists() {
    if (!root.ready) return
    var argv = MaApi.buildArgs(root.config.url, root.config.token,
      "music/playlists/all", { limit: 100 }, "playlists")
    playlistsProc.command = argv
    playlistsProc.running = true
  }

  function refreshRecent() {
    if (!root.ready) return
    var argv = MaApi.buildArgs(root.config.url, root.config.token,
      "music/recently_played_items", { limit: root.config.recentLimit || 50 }, "recent")
    recentProc.command = argv
    recentProc.running = true
  }

  function saveQueueAsPlaylist(name) {
    if (!name || !root.queue || root.queue.length === 0) return
    var argv = MaApi.buildArgs(root.config.url, root.config.token,
      "music/playlists/create_playlist", { name: name }, "save-q-create")
    root.saveQueuePhase = "create"
    saveQueueProc.phase = "create"
    saveQueueProc.name = name
    saveQueueProc.command = argv
    saveQueueProc.running = true
  }

  // ---------------------------------------------------------------- IPC

  IpcHandler {
    target: root.ipcTarget

    function status(): string {
      return JSON.stringify({
        ready: root.ready,
        connected: root.connected,
        lastError: root.lastError,
        configError: root.configError,
        activePlayerId: root.activePlayerId,
        activePlayerName: root.activePlayer ? root.activePlayer.name : "",
        isPlaying: root.isPlaying,
        title: root.activeTitle,
        artist: root.activeArtist,
        album: root.activeAlbum,
        imageUrl: root.activeImageUrl,
        volume: root.activeVolume,
        muted: root.activePlayer ? !!root.activePlayer.volume_muted : false,
        playerCount: root.players.length,
        queueLength: root.queue.length,
        shuffle: root.shuffleEnabled,
        repeat: root.repeatMode,
        elapsed: root.activeElapsed,
        duration: root.activeDuration,
        pollingState: root.pollingActive ? "active" : "stopped",
        pollingActive: root.pollingActive
      })
    }

    function playPause(): string {
      root.playPause()
      return "ok"
    }

    function nextTrack(): string {
      root.next()
      return "ok"
    }

    function previousTrack(): string {
      root.previous()
      return "ok"
    }

    function setVolumePct(percent: real): string {
      root.setVolume(root.activePlayerId, percent)
      return "ok"
    }

    function activatePlayerById(playerId: string): string {
      root.activatePlayer(playerId)
      return "ok"
    }

    function transferQueueTo(targetId: string): string {
      root.transferQueue(root.activePlayerId, targetId)
      return "ok"
    }

    function playUri(uri: string): string {
      root.playUri(root.activePlayerId, uri)
      return "ok"
    }

    function playUriOn(playerId: string, uri: string): string {
      root.playUri(playerId, uri)
      return "ok"
    }

    function search(q: string): string {
      root.search(q)
      return "ok"
    }

    function clearQueueNow(): string {
      root.clearQueue(root.activePlayerId)
      return "ok"
    }

    function refresh(): string {
      root.refreshState()
      return "ok"
    }

    function playersList(): string {
      var list = []
      for (var i = 0; i < root.players.length; i++) {
        var p = root.players[i]
        list.push({
          id: p.player_id,
          name: p.name,
          available: p.available,
          playing: p.playback_state === "playing",
          paused: p.playback_state === "paused",
          volume: MaApi.volumePercent(p),
          muted: !!p.volume_muted,
          title: MaApi.trackTitle(p.current_media),
          artist: MaApi.trackArtist(p.current_media),
          imageUrl: MaApi.trackImageUrl(p.current_media)
        })
      }
      return JSON.stringify(list)
    }

    function seek(positionMs: real): string {
      root.seek(root.activePlayerId, positionMs)
      return "ok"
    }

    function seekRelative(deltaMs: real): string {
      root.seekRelative(deltaMs)
      return "ok"
    }

    function toggleShuffle(): string {
      root.toggleShuffle(root.activePlayerId)
      return "ok"
    }

    function cycleRepeat(): string {
      root.cycleRepeat(root.activePlayerId)
      return "ok"
    }

    function power(action: string): string {
      root.power(root.activePlayerId, action === "on")
      return "ok"
    }

    function favoriteCurrent(): string {
      root.favoriteCurrent()
      return "ok"
    }

    function favoriteAdd(uri: string): string {
      root.addFavorite(uri)
      return "ok"
    }

    function favoriteRemove(uri: string): string {
      root.removeFavorite(uri)
      return "ok"
    }

    function saveQueue(name: string): string {
      root.saveQueueAsPlaylist(name)
      return "ok"
    }

    function openWebUI(): string {
      root.openWebUI()
      return "ok"
    }

    function refreshFavorites(): string {
      root.refreshFavorites()
      return "ok"
    }

    function refreshPlaylists(): string {
      root.refreshPlaylists()
      return "ok"
    }

    function refreshRecent(): string {
      root.refreshRecent()
      return "ok"
    }
  }
}