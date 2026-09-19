import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Mpris
import qs.Commons
import "MaApi.js" as MaApi
import "MaData.js" as MaData
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
  // Runtime config must live outside Omarchy's watched plugin source tree.
  readonly property string configPath: (Quickshell.env("XDG_CONFIG_HOME") || home + "/.config") + "/music-assistant/config.json"

  // ---------------------------------------------------------------- state
  property var players: []
  property string activePlayerId: ""
  property string activeQueueId: ""
  property string activeQueuePlayerId: ""
  property int queueEpoch: 0
  property var queue: []
  property int queuePosition: -1
  property var searchResults: null
  property string searchQuery: ""
  property string lastError: ""
  property bool connected: false

  // ------------------------------------------------------- local playback
  readonly property bool localPlayerEnabled: !!(root.config.localPlayer && root.config.localPlayer.enabled)
  readonly property string localPlayerExecutable: root.home + "/.local/bin/omarchy-ma-player"
  property var localPlayerState: ({ phase: "stopped", ready: false, playerId: "", playing: false, error: "" })
  property string localPlayerId: ""
  readonly property bool localPlayerReady: root.localPlayerEnabled && root.localPlayerState.ready === true && root.localPlayerId.length > 0
  // Retain identity while disconnected so media keys cannot jump to another app.
  readonly property bool localPlayerSelected: root.localPlayerEnabled && root.localPlayerId.length > 0 && root.activePlayerId === root.localPlayerId
  property bool localControlBusy: false
  property bool playHerePending: false
  property bool helperInstalled: false
  property int requestEpoch: 0
  readonly property string installerPath: {
    var url = Qt.resolvedUrl("local-player/install.sh").toString()
    return url.indexOf("file://") === 0 ? url.slice(7) : url
  }

  function localPlayerStatus() {
    return JSON.stringify({ enabled: root.localPlayerEnabled, phase: root.localPlayerState.phase,
      ready: root.localPlayerReady, playerId: root.localPlayerId,
      playing: root.localPlayerState.playing, error: root.localPlayerState.error,
      busy: root.localControlBusy, playHerePending: root.playHerePending })
  }

  function refreshLocalPlayerStatus() {
    if (!root.ready || !root.localPlayerEnabled || root.localControlBusy || localStatusProc.busy) return
    localStatusProc.enqueue({ command: [root.localPlayerExecutable, "status"], stdin: "",
      local: true, statusOnly: true, epoch: root.requestEpoch })
  }

  function decodeLocalStatus(text, code) {
    if (code !== 0 || !text || text.length > 16384) throw new Error("HELPER_STATUS_FAILED")
    var value = JSON.parse(String(text))
    if (!value || typeof value.ready !== "boolean" || typeof value.phase !== "string") throw new Error("INVALID_STATUS")
    var id = typeof value.playerId === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.playerId) ? value.playerId : ""
    var phases = ["idle", "unlocking", "remote-connecting", "authenticating", "opening-sendspin", "sdk-connecting", "pairing", "waiting-player", "ready", "failed", "disconnected", "starting", "reconnecting", "stopped", "installing"]
    return { phase: phases.indexOf(value.phase) >= 0 ? value.phase : "connecting",
      ready: value.phase === "ready" && value.ready === true && !!id && !value.error, playerId: id, playing: value.playing === true,
      error: value.error ? "LOCAL_PLAYER_ERROR" : "" }
  }

  MaRequest {
    id: localStatusProc
    handleReply: function(value, context) {
      var wasReady = root.localPlayerReady
      root.localPlayerState = value
      if (value.playerId) root.localPlayerId = value.playerId
      if (!value.ready && (wasReady || root.connected)) root.requestFailed("LOCAL_PLAYER_NOT_READY")
      if (value.ready && !wasReady) root.refreshState()
      root.selectLocalPlayer()
    }
    onCompleted: function(code, status, context) {
      if (code !== 0) {
        root.localPlayerState = ({ phase: "error", ready: false, playing: false, error: "HELPER_STATUS_FAILED" })
      }
    }
  }

  Timer {
    interval: 2000
    repeat: true
    running: root.ready && root.localPlayerEnabled
    triggeredOnStart: true
    onTriggered: root.refreshLocalPlayerStatus()
  }

  function runLocalControl(verb) {
    if (!root.ready || !root.localPlayerEnabled) return "LOCAL_PLAYER_DISABLED"
    if (root.localControlBusy) return "LOCAL_PLAYER_BUSY"
    if (["start", "stop", "restart", "enable", "disable"].indexOf(verb) < 0) return "INVALID_ACTION"
    root.localControlBusy = true
    root.requestFailed("")
    root.localPlayerState = ({ phase: verb === "stop" ? "stopped" : "starting", ready: false, playing: false, error: "" })
    localControlProc.command = ["systemctl", "--user", verb, "omarchy-ma-player.service"]
    localControlTimeout.restart()
    localControlProc.running = true
    return "ok"
  }

  function startLocalPlayer() { return root.runLocalControl("start") }
  function stopLocalPlayer() {
    root.playHerePending = false
    return root.runLocalControl("stop")
  }
  function restartLocalPlayer() { return root.runLocalControl("restart") }
  function enableLocalPlayer() { return root.runLocalControl("enable") }
  function disableLocalPlayer() { return root.runLocalControl("disable") }

  Process {
    id: localControlProc
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(code) {
      localControlTimeout.stop()
      root.localControlBusy = false
      if (code !== 0) {
        root.playHerePending = false
        root.localPlayerState = ({ phase: "error", ready: false, playing: false, error: "LOCAL_CONTROL_FAILED" })
        root.requestFailed("LOCAL_CONTROL_FAILED")
      } else Qt.callLater(root.refreshLocalPlayerStatus)
    }
  }
  Timer {
    id: localControlTimeout
    interval: 15000
    onTriggered: {
      localControlProc.signal(9)
      root.localControlBusy = false
      root.playHerePending = false
      root.localPlayerState = ({ phase: "error", ready: false, playing: false, error: "LOCAL_CONTROL_TIMEOUT" })
      root.requestFailed("LOCAL_CONTROL_TIMEOUT")
    }
  }

  function playHere() {
    if (!root.localPlayerEnabled) return "LOCAL_PLAYER_DISABLED"
    if (root.localControlBusy) return "LOCAL_PLAYER_BUSY"
    root.playHerePending = true
    if (root.localPlayerReady) root.selectLocalPlayer()
    else return root.startLocalPlayer()
    return "ok"
  }

  function playOnThisDevice() {
    if (!root.ready) return "NOT_READY"
    if (root.localControlBusy) return "LOCAL_PLAYER_BUSY"
    var lp = root.config.localPlayer || {}
    if (!lp.remoteId) return "LOCAL_PLAYER_NEEDS_REMOTE_ID"
    root.playHerePending = true
    root.requestFailed("")
    if (root.localPlayerEnabled) {
      if (root.localPlayerReady) {
        root.selectLocalPlayer()
        return "ok"
      }
      return root.startLocalPlayer()
    }
    if (root.helperInstalled) return root.enableAndStartLocalPlayer()
    return root.startInstaller()
  }

  function enableAndStartLocalPlayer() {
    if (!root.config.localPlayer) return "LOCAL_PLAYER_DISABLED"
    var next = JSON.parse(JSON.stringify(root.config))
    next.localPlayer.enabled = true
    root.config = next
    root.persistConfig()
    return root.startLocalPlayer()
  }

  function startInstaller() {
    if (root.localControlBusy) return "LOCAL_PLAYER_BUSY"
    if (!root.installerPath || root.installerPath.indexOf("/local-player/install.sh") < 0)
      return "LOCAL_INSTALL_MISSING"
    root.localControlBusy = true
    root.requestFailed("")
    root.localPlayerState = ({ phase: "installing", ready: false, playing: false, error: "" })
    installerProc.command = ["bash", root.installerPath]
    installerTimeout.restart()
    installerProc.running = true
    return "ok"
  }

  function refreshHelperInstalled() {
    if (helperCheckProc.running) return
    helperCheckProc.command = ["test", "-x", root.localPlayerExecutable]
    helperCheckProc.running = true
  }

  Process {
    id: helperCheckProc
    onExited: function(code) { root.helperInstalled = code === 0 }
  }

  Process {
    id: webUiProc
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
  }

  Process {
    id: installerProc
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(code) {
      installerTimeout.stop()
      root.localControlBusy = false
      if (code !== 0) {
        root.playHerePending = false
        root.localPlayerState = ({ phase: "error", ready: false, playing: false, error: "LOCAL_INSTALL_FAILED" })
        root.requestFailed("LOCAL_INSTALL_FAILED")
        return
      }
      root.helperInstalled = true
      root.enableAndStartLocalPlayer()
    }
  }
  Timer {
    id: installerTimeout
    interval: 180000
    onTriggered: {
      installerProc.signal(9)
      root.localControlBusy = false
      root.playHerePending = false
      root.localPlayerState = ({ phase: "error", ready: false, playing: false, error: "LOCAL_INSTALL_TIMEOUT" })
      root.requestFailed("LOCAL_INSTALL_TIMEOUT")
    }
  }

  function selectLocalPlayer() {
    if (!root.playHerePending || !root.localPlayerReady) return
    var player = root.playerById(root.localPlayerId)
    if (!player || !player.available) return
    root.playHerePending = false
    // Selection only: never transfers, replaces or starts another player's queue.
    root.activatePlayer(root.localPlayerId)
  }
  Timer {
    interval: 45000
    running: root.playHerePending
    onTriggered: { root.playHerePending = false; root.lastError = "LOCAL_PLAYER_NOT_READY" }
  }

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
    if (root.localPlayerEnabled && (!root.localPlayerId || root.localPlayerSelected)) return false
    return !root.localPlayerSelected && root.config && root.config.mprisFallback !== false
  }
  property string preferredPlayerId: ""
  property var favorites: ({ tracks: [], albums: [], artists: [], playlists: [], radio: [] })
  property var _favTypes: []
  property int _favIndex: 0
  property var playlists: []
  property var recentItems: []

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
  readonly property int activeDuration: activeMedia && activeMedia.duration ? Math.round(activeMedia.duration * 1000) : 0
  readonly property int activeElapsed: activeMedia && activeMedia.elapsed_time ? Math.round(activeMedia.elapsed_time * 1000) : 0
  readonly property bool isFavorite: {
    var m = root.activeMedia
    if (!m) return false
    if (m.favorite === true) return true
    var uri = m.uri
    var tracks = root.favorites && root.favorites.tracks
    if (!uri || !tracks) return false
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i] && tracks[i].uri === uri) return true
    }
    return false
  }

  // ---------------------------------------------------------------- config loader

  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    printErrors: false
    onLoaded: root.applyConfig(text())
    onFileChanged: reload()
    onLoadFailed: function(err) {
      root.configError = "config.json missing or unreadable"
      root.config = ({})
      root.ready = false
      root.stopConnection()
      root.requestFailed("CONFIG_UNREADABLE")
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
    // Remote/local playback must not rewrite the desktop's existing key routing.
    if (root.localPlayerEnabled) return
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
      "hyprctl reload >/dev/null 2>&1 || true\n" +
      // Exit 42 = we just installed (caller shows first-run OSD)
      "exit 42\n"
  }

  Process {
    id: mediaKeysInstaller
    command: [Quickshell.env("SHELL") || "/bin/bash", "-c", root.mediaKeysInstallScript]
    onExited: function(exitCode) {
      if (exitCode === 0) {
        console.log("[music-assistant] Media key bindings: nothing to do (already installed)")
      } else if (exitCode === 42) {
        console.log("[music-assistant] Media key bindings installed (first run)")
        root.showOsd(
          "Media keys enabled",
          "media-play",
          "XF86AudioPlay/Pause/Next/Prev now control Music Assistant. " +
          "Revert by removing the music-assistant media-keys block in ~/.config/hypr/bindings.lua."
        )
      } else {
        console.warn("[music-assistant] Failed to install media key bindings: exitCode=" + exitCode)
      }
    }
  }

  // --------------------------------------------------- config persistence

  property string pendingConfigJson: ""

  Process {
    id: configSaver
    property string savePath: ""
    property string saveJson: ""
    property bool savePending: false
    stdinEnabled: true
    onStarted: { write(saveJson + "\n"); saveJson = ""; stdinEnabled = false }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        console.log("[music-assistant] Config persisted to " + savePath)
      } else {
        console.warn("[music-assistant] Failed to persist config (exit=" + exitCode + ")")
      }
      if (savePending) Qt.callLater(root.flushConfigSave)
      else configFile.reload()
    }
  }

  function configSaveScript(path) {
    var safePath = path.replace(/'/g, "'\\''")
    var lastSlash = path.lastIndexOf("/")
    var safeDir = (lastSlash >= 0 ? path.substring(0, lastSlash) : ".").replace(/'/g, "'\\''")
    // Atomic private write. JSON/token travel only on stdin, never shell argv.
    return "set -e\n" +
      "umask 077\n" +
      "D='" + safeDir + "'\n" +
      "F='" + safePath + "'\n" +
      "mkdir -p -- \"$D\"\n" +
      "T=$(mktemp -p \"$D\" ma-config.XXXXXXXXXX)\n" +
      "trap 'rm -f -- \"$T\"' EXIT\n" +
      "exec 3> \"$T\"\n" +
      "cat >&3\n" +
      "exec 3>&-\n" +
      "chmod 600 \"$T\"\n" +
      "mv -f \"$T\" \"$F\"\n"
  }

  function persistConfig() {
    if (!root.ready || !root.config) return
    // Capture intent now, not after the previous write's watcher notification.
    root.pendingConfigJson = JSON.stringify(root.config, null, 2)
    configSaver.savePending = true
    root.flushConfigSave()
  }

  function flushConfigSave() {
    if (configSaver.running || !configSaver.savePending) return
    var path = root.configPath
    var json = root.pendingConfigJson
    configSaver.savePending = false
    configSaver.savePath = path
    configSaver.saveJson = json
    configSaver.command = [Quickshell.env("SHELL") || "/bin/bash", "-c",
      root.configSaveScript(path)]
    configSaver.stdinEnabled = true
    configSaver.running = true
  }

  function applyConfig(text) {
    // Own atomic writes can notify before exit; reload the final file on exit.
    if (configSaver.running || configSaver.savePending) return
    var result = ConfigSchema.parse(text)
    var previous = JSON.stringify([root.config.url, root.config.token, root.config.localPlayer])
    var next = JSON.stringify([result.config.url, result.config.token, result.config.localPlayer])
    if (previous !== next || result.error) {
      root.requestFailed("")
      root.playHerePending = false
      root.localPlayerId = ""
      root.localPlayerState = ({ phase: "stopped", ready: false, playing: false, error: "" })
    }
    root.config = result.config
    root.preferredPlayerId = result.config.preferredPlayerId || ""
    root.ready = result.error.length === 0
    root.configError = result.error
    if (root.ready) {
      root.startConnection()
      Qt.callLater(function() { root.installMediaKeysBindings() })
      Qt.callLater(root.refreshHelperInstalled)
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
    root.refreshLocalPlayerStatus()
    pollTimer.restart()
  }

  function stopConnection() {
    pollTimer.stop()
    root.pollingActive = false
  }

  function refreshState() {
    if (!root.ready || (root.localPlayerEnabled && (!root.localPlayerReady || root.localControlBusy))) return
    if (root.pollInFlight || playersProc.busy || activeQueueProc.busy || queueProc.busy) return
    root.pollInFlight = true
    root.runFetchPlayers()
  }

  // Every RPC, including library flows, must share the helper's authenticated
  // browser session. Never fall back to HTTP when local playback is enabled.
  function buildRequest(command, args, messageId) {
    if (root.localPlayerEnabled) {
      return { command: [root.localPlayerExecutable, "request"],
        stdin: JSON.stringify({ command: command, args: args || {} }) + "\n",
        local: true, epoch: root.requestEpoch }
    }
    var payload = MaApi.buildArgs(root.config.url, root.config.token, command, args, messageId)
    return { command: [Quickshell.env("SHELL") || "/bin/bash", "-c", payload.script],
      stdin: (payload.token || "") + "\n", local: false, epoch: root.requestEpoch }
  }

  function runMaRequest(proc, payload) {
    if (!root.ready || !payload) return false
    if (root.localPlayerEnabled && (!root.localPlayerReady || root.localControlBusy)) {
      root.pollInFlight = false
      root.lastError = "LOCAL_PLAYER_NOT_READY"
      return false
    }
    return proc.enqueue(payload)
  }

  function requestFailed(code) {
    root.requestEpoch++
    root.lastError = code
    root.connected = false
    root.players = []
    root.queue = []
    root.queuePosition = -1
    root.activeQueueId = ""
    root.activeQueuePlayerId = ""
    root.queueEpoch++
    root.shuffleEnabled = false
    root.repeatMode = "off"
    root.pollInFlight = false
    root.searchResults = null
    root.favorites = ({ tracks: [], albums: [], artists: [], playlists: [], radio: [] })
    root.playlists = []
    root.recentItems = []
    root._favTypes = []
  }

  // A Process cannot be restarted from its stdout callback. Queue immutable
  // jobs (including callbacks/context) and wait for both stream EOF and exit.
  component MaRequest: Process {
    id: request
    property var jobs: []
    property var job: null
    property bool busy: false
    property bool streamDone: false
    property bool processExited: false
    property bool timedOut: false
    property int exitCode: -1
    property int exitStatus: 0
    property var handleReply: null
    signal completed(int code, int status, var context)

    function enqueue(payload) {
      if (jobs.length >= 16) { root.lastError = "REQUEST_BUSY"; return false }
      jobs = jobs.concat([payload])
      drain()
      return true
    }
    function drain() {
      if (busy) return
      while (jobs.length > 0) {
        var next = jobs[0]
        jobs = jobs.slice(1)
        if (next.epoch !== root.requestEpoch) continue
        job = next
        busy = true
        streamDone = false
        processExited = false
        timedOut = false
        exitCode = -1
        stdinEnabled = true
        command = job.command
        requestTimeout.restart()
        running = true
        return
      }
    }
    function finish() {
      if (!busy || !processExited || !streamDone) return
      requestTimeout.stop()
      var current = job
      var code = timedOut ? -1 : exitCode
      var obsolete = job.epoch !== root.requestEpoch
      // Config changes and connection loss invalidate replies already in flight.
      if (obsolete) code = -1
      else {
        try {
          var value = current.statusOnly ? root.decodeLocalStatus(request.stdout.text, code)
            : root.decodeReply(request.stdout.text, code, current.local)
          if (typeof handleReply === "function") handleReply(value, current.context || {})
        } catch (e) {
          code = code || -1
          root.requestFailed(current.local ? "HELPER_REQUEST_FAILED" : "MA_REQUEST_FAILED")
        }
      }
      // Obsolete completion handlers must not overwrite a new session's state.
      if (!obsolete) completed(code, exitStatus, current.context || {})
      job = null
      busy = false
      Qt.callLater(drain)
    }
    onStarted: {
      write(job.stdin)
      job.stdin = ""
      stdinEnabled = false
    }
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: { request.streamDone = true; request.finish() }
    }
    // Do not forward stderr (a server/transport may put credentials in errors).
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(code, status) {
      exitCode = code
      exitStatus = status
      processExited = true
      finish()
    }
    function expire() {
      timedOut = true
      if (running) {
        signal(9)
        // Retry cleanup if EOF or exited is absent after the kill.
        requestTimeout.restart()
      } else {
        exitCode = -1
        processExited = true
        streamDone = true
        finish()
      }
    }
    property Timer watchdog: Timer {
      id: requestTimeout
      interval: request.timedOut ? 1000 : (request.job && !request.job.statusOnly ? 45000 : 15000)
      onTriggered: request.expire()
    }
  }

  function decodeReply(text, code, local) {
    if (code !== 0 || !text || text.length > MaApi.MAX_RESPONSE_BYTES) throw new Error("REQUEST_FAILED")
    var payload = JSON.parse(String(text))
    if (payload === null || payload === undefined || payload.error || payload.error_code) throw new Error("REQUEST_FAILED")
    var wrapped = Object.prototype.hasOwnProperty.call(payload, "result")
    if (local && !wrapped) throw new Error("INVALID_HELPER_REPLY")
    return wrapped ? payload.result : payload
  }

  function runFetchPlayers() {
    if (!root.ready) { root.pollInFlight = false; return }
    var payload = root.buildRequest("players/all", {}, "poll-players")
    root.runMaRequest(playersProc, payload)
  }

  function runFetchQueue(playerId) {
    if (!root.ready || !playerId) { root.pollInFlight = false; return }
    var payload = root.buildRequest("player_queues/get_active_queue", { player_id: playerId }, "poll-active-queue")
    payload.context = { playerId: playerId, queueEpoch: root.queueEpoch }
    if (!root.runMaRequest(activeQueueProc, payload)) root.pollInFlight = false
  }

  function runFetchQueueItems(playerId) {
    if (!root.activeQueueId || root.activeQueuePlayerId !== playerId) { root.pollInFlight = false; return }
    var payload = root.buildRequest(
      "player_queues/items",
      { queue_id: root.activeQueueId, limit: 200, offset: 0 },
      "poll-queue")
    payload.context = { playerId: playerId, queueId: root.activeQueueId, queueEpoch: root.queueEpoch }
    if (!root.runMaRequest(queueProc, payload)) root.pollInFlight = false
  }

  function resetQueueContext() {
    root.queueEpoch++
    root.activeQueueId = ""
    root.activeQueuePlayerId = ""
    root.queue = []
    root.queuePosition = -1
    root.shuffleEnabled = false
    root.repeatMode = "off"
  }

  function setActivePlayer(playerId) {
    if (playerId === root.activePlayerId) return
    root.resetQueueContext()
    root.activePlayerId = playerId
  }

  function applyActiveQueue(value, playerId) {
    var queueId = value ? MaApi.boundedString(value.queue_id, 100) : ""
    if (queueId !== root.activeQueueId) root.queue = []
    root.activeQueueId = queueId
    root.activeQueuePlayerId = root.activeQueueId ? playerId : ""
    root.queuePosition = value && typeof value.current_index === "number" ? value.current_index : -1
    root.shuffleEnabled = !!(value && value.shuffle_enabled)
    root.repeatMode = value && ["off", "all", "one"].indexOf(value.repeat_mode) >= 0 ? value.repeat_mode : "off"
    if (!root.activeQueueId) root.queue = []
  }

  MaRequest {
    id: playersProc
    handleReply: function(value, context) {
      if (!root.applyPlayers(value)) return
      root.selectLocalPlayer()
      root.setActivePlayer(root.pickNextActivePlayer())
      root.runFetchQueue(root.activePlayerId)
    }
    onCompleted: function(code, status, context) {
      if (code !== 0) root.pollInFlight = false
    }
  }

  MaRequest {
    id: activeQueueProc
    handleReply: function(value, context) {
      if (context.playerId !== root.activePlayerId || context.queueEpoch !== root.queueEpoch) {
        root.pollInFlight = false
        return
      }
      root.applyActiveQueue(value, context.playerId)
      root.runFetchQueueItems(context.playerId)
    }
    onCompleted: function(code, status, context) {
      if (code !== 0) root.pollInFlight = false
    }
  }

  MaRequest {
    id: queueProc
    handleReply: function(value, context) {
      if (context.playerId === root.activePlayerId && context.queueId === root.activeQueueId && context.queueEpoch === root.queueEpoch) root.applyQueue(value)
    }
    onCompleted: function(code, status, context) { root.pollInFlight = false }
  }

  function applyPlayers(list) {
    if (!Array.isArray(list)) {
      root.requestFailed("INVALID_PLAYERS")
      return false
    }
    var bounded = MaApi.boundedArray(list, MaApi.MAX_PLAYERS).map(function(p) {
      return {
        player_id: MaApi.boundedString(p.player_id, 100),
        name: MaApi.boundedString(p.name, 200),
        available: !!p.available,
        powered: p.powered === undefined ? true : !!p.powered,
        playback_state: MaApi.boundedString(p.playback_state, 20),
        volume_muted: !!p.volume_muted,
        volume_level: typeof p.volume_level === "number" ? Math.max(0, Math.min(100, p.volume_level)) : null,

        current_media: p.current_media || null,
        group_members: Array.isArray(p.group_members) ? MaApi.boundedArray(p.group_members, 16).map(function(g) { return MaApi.boundedString(g, 100) }) : [],
        hide_in_ui: !!p.hide_in_ui,
        synced_to: MaApi.boundedString(p.synced_to, 100)
      }
    })
    root.players = bounded
    root.connected = true
    root.lastError = ""
    return true
  }

  function applyQueue(payload) {
    if (!payload) {
      root.queue = []
      return
    }
    var raw = Array.isArray(payload) ? payload : (payload.items || [])
    var items = MaApi.boundedArray(raw, MaApi.MAX_QUEUE_ITEMS).map(function(it) {
      return MaData.queueItem(it)
    })
    root.queue = items
  }

  function pickNextActivePlayer() {
    // An unavailable selected local player must not silently select another queue.
    if (root.localPlayerEnabled && root.localPlayerId && root.preferredPlayerId === root.localPlayerId) return root.localPlayerId
    return MaApi.pickActivePlayerId(root.players, root.preferredPlayerId)
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

  function runAction(command, args) {
    if (!root.ready || !root.connected) return false
    var payload = root.buildRequest(command, args)
    return root.runMaRequest(actionProc, payload)
  }

  MaRequest {
    id: actionProc
    onCompleted: refreshTimer.restart()
  }

  Timer {
    id: refreshTimer
    interval: 250
    repeat: false
    onTriggered: root.refreshState()
  }

  function actionForPlayer(playerId, command, args) {
    var pid = playerId || root.activePlayerId
    if (!pid || !root.playerById(pid) || !root.playerById(pid).available) return
    var a = args ? Object.assign({}, args) : {}
    if (command.indexOf("players/cmd/") === 0) a.player_id = pid
    else {
      if (pid === root.activePlayerId) {
        if (!root.activeQueueId || root.activeQueuePlayerId !== pid) return false
        a.queue_id = root.activeQueueId
      } else a.queue_id = pid
    }
    return root.runAction(command, a)
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
      (MaApi.trackTitle((root.playerById(pid) || {}).current_media) || "Music Assistant"))
  }

  function next(playerId) {
    if (root.mprisRoutingEnabled() && root.activeMprisPlayer) {
      if (root.activeMprisPlayer.canGoNext) root.activeMprisPlayer.next()
      return
    }
    root.actionForPlayer(playerId, "player_queues/next")
    root.showOsd("Next", "media-next", MaApi.trackTitle((root.playerById(playerId || root.activePlayerId) || {}).current_media))
  }

  function previous(playerId) {
    if (root.mprisRoutingEnabled() && root.activeMprisPlayer) {
      if (root.activeMprisPlayer.canGoPrevious) root.activeMprisPlayer.previous()
      return
    }
    root.actionForPlayer(playerId, "player_queues/previous")
    root.showOsd("Previous", "media-previous", MaApi.trackTitle((root.playerById(playerId || root.activePlayerId) || {}).current_media))
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
    var source = sourceId || root.activePlayerId
    if (source === root.activePlayerId) {
      if (!root.activeQueueId || root.activeQueuePlayerId !== source) return
      source = root.activeQueueId
    }
    root.runAction("player_queues/transfer", {
      source_queue_id: source,
      target_queue_id: targetId,
      auto_play: true
    })
    root.preferredPlayerId = targetId
    root.setActivePlayer(targetId)
    if (root.config) {
      root.config.preferredPlayerId = targetId
      root.persistConfig()
    }
    root.refreshState()
  }

  function activatePlayer(playerId) {
    if (!root.playerById(playerId) || !root.playerById(playerId).available) return
    root.preferredPlayerId = playerId
    root.setActivePlayer(playerId)
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
    var payload = root.buildRequest(
      "music/search",
      { search_query: query, limit: lim, media_types: ["track", "album", "artist", "playlist"] },
      "search-" + Date.now())
    payload.context = { query: query }
    root.runMaRequest(searchProc, payload)
  }

  function clearSearch() {
    root.searchResults = null
    root.searchQuery = ""
  }

  function _boundMediaItem(it) {
    if (!it) return null
    return MaData.mediaItem(it)
  }

  function _boundSearchResults(raw) {
    if (!raw || typeof raw !== "object") return null
    return {
      tracks: MaApi.boundedArray(raw.tracks || [], MaApi.MAX_SEARCH_TRACKS).map(_boundMediaItem),
      albums: MaApi.boundedArray(raw.albums || [], MaApi.MAX_SEARCH_ALBUMS).map(_boundMediaItem),
      artists: MaApi.boundedArray(raw.artists || [], MaApi.MAX_SEARCH_ARTISTS).map(_boundMediaItem),
      playlists: MaApi.boundedArray(raw.playlists || [], MaApi.MAX_SEARCH_PLAYLISTS).map(_boundMediaItem)
    }
  }

  MaRequest {
    id: searchProc
    handleReply: function(value, context) {
      if (context.query !== root.searchQuery) return
      root.searchResults = root._boundSearchResults(value)
    }
  }

  MaRequest {
    id: favProc
    handleReply: function(value, context) {
      var bounded = MaApi.boundedArray(value, MaApi.MAX_FAVORITES_PER_TYPE).map(root._boundMediaItem).filter(function(x) { return x !== null })
      var next = Object.assign({}, root.favorites)
      next[context.typeKey] = bounded
      root.favorites = next
      root._favFetchNext()
    }
  }

  MaRequest {
    id: playlistsProc
    handleReply: function(value, context) {
      root.playlists = MaApi.boundedArray(value, MaApi.MAX_PLAYLISTS).map(root._boundMediaItem).filter(function(x) { return x !== null })
    }
  }

  MaRequest {
    id: recentProc
    handleReply: function(value, context) {
      root.recentItems = MaApi.boundedArray(value, MaApi.MAX_RECENT_ITEMS).filter(function(it) { return !!it }).map(root._boundMediaItem)
    }
  }

  MaRequest {
    id: saveQueueProc
  }

  function seek(playerId, positionMs) {
    var pid = playerId || root.activePlayerId
    if (!pid) return
    var p = Math.max(0, Math.round(positionMs))
    if (!isFinite(p)) return
    root.actionForPlayer(pid, "player_queues/seek", { position: p / 1000 })
  }

  function seekRelative(deltaMs) {
    var cur = root.activeElapsed
    root.seek(root.activePlayerId, cur + deltaMs)
  }

  function toggleShuffle(playerId) {
    var pid = playerId || root.activePlayerId
    if (pid !== root.activePlayerId) return
    var next = !root.shuffleEnabled
    if (root.actionForPlayer(pid, "player_queues/shuffle", { shuffle_enabled: next })) root.shuffleEnabled = next
  }

  function cycleRepeat(playerId) {
    var pid = playerId || root.activePlayerId
    if (pid !== root.activePlayerId) return
    var cur = root.repeatMode
    var next = cur === "off" ? "all" : (cur === "all" ? "one" : "off")
    if (root.actionForPlayer(pid, "player_queues/repeat", { repeat_mode: next })) root.repeatMode = next
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
    var match = /^library:\/\/(track|album|artist|playlist|radio|audiobook|podcast)\/([0-9]+)$/.exec(String(uri))
    if (!match) { root.lastError = "FAVORITE_REQUIRES_LIBRARY_ITEM"; return }
    root.actionForSourceTarget("music/favorites/remove_item", { media_type: match[1], library_item_id: match[2] })
    root.refreshFavorites()
  }

  function favoriteCurrent() {
    var m = root.activeMedia
    if (!m || !m.uri) return
    root.addFavorite(m.uri)
    root.showOsd("Favorited", "favorite", MaApi.trackTitle(m))
  }

  function webUiUrl() {
    var url = root.config && root.config.openWebUiPath && root.config.openWebUiPath.length > 0
      ? root.config.openWebUiPath : (root.config && root.config.url ? root.config.url : "")
    if (typeof url !== "string") return ""
    url = url.trim()
    if ((url.indexOf("http://") !== 0 && url.indexOf("https://") !== 0) || url.length > 2048) return ""
    return url
  }

  function openWebUI() {
    var url = root.webUiUrl()
    if (!url || webUiProc.running) return
    webUiProc.command = ["omarchy-launch-browser", url]
    webUiProc.running = true
  }

  function refreshFavorites() {
    if (!root.ready || favProc.busy) return
    root._favTypes = ["tracks", "albums", "artists", "playlists", "radio"]
    root._favIndex = 0
    root._favFetchNext()
  }

  function _favFetchNext() {
    if (root._favIndex >= root._favTypes.length) return
    var t = root._favTypes[root._favIndex++]
    var payload = root.buildRequest(
      "music/" + (t === "radio" ? "radios" : t) + "/library_items", { favorite: true, limit: 50, offset: 0 }, "fav-" + t)
    payload.context = { typeKey: t }
    root.runMaRequest(favProc, payload)
  }

  function refreshPlaylists() {
    if (!root.ready) return
    var payload = root.buildRequest(
      "music/playlists/library_items", { limit: 100, offset: 0 }, "playlists")
    root.runMaRequest(playlistsProc, payload)
  }

  function refreshRecent() {
    if (!root.ready) return
    var payload = root.buildRequest(
      "music/recently_played_items", { limit: root.config.recentLimit || 50 }, "recent")
    root.runMaRequest(recentProc, payload)
  }

  function saveQueueAsPlaylist(name) {
    if (!name || !root.activeQueueId || root.activeQueuePlayerId !== root.activePlayerId || !root.queue || root.queue.length === 0 || saveQueueProc.busy) return
    var payload = root.buildRequest(
      "player_queues/save_as_playlist", { queue_id: root.activeQueueId, name: name }, "save-q")
    root.runMaRequest(saveQueueProc, payload)
  }

  // ---------------------------------------------------------------- IPC

  IpcHandler {
    target: root.ipcTarget

    function localPlayerStatus(): string { return root.localPlayerStatus() }
    function startLocalPlayer(): string { return root.startLocalPlayer() }
    function stopLocalPlayer(): string { return root.stopLocalPlayer() }
    function restartLocalPlayer(): string { return root.restartLocalPlayer() }
    function playHere(): string { return root.playHere() }
    function playOnThisDevice(): string { return root.playOnThisDevice() }
    function enableLocalPlayer(): string { return root.enableLocalPlayer() }
    function disableLocalPlayer(): string { return root.disableLocalPlayer() }

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