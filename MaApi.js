.pragma library

var counter = 0

// Bash script that reads the bearer token from stdin, writes it to a
// 0600-mode temp file, runs curl with the Authorization header sourced
// from that file (-H @file), and removes the file on exit. The token
// never appears in any process's argv, only on stdin (which is not
// visible via /proc/PID/cmdline).
function _buildCurlScript(url, bodyJson, maxTime, includeOutput) {
  var escapedUrl = url.replace(/'/g, "'\\''")
  var escapedBody = bodyJson.replace(/'/g, "'\\''")
  return "set -e\n" +
    "F=$(mktemp -t ma-auth.XXXXXX)\n" +
    "chmod 600 \"$F\"\n" +
    "trap 'rm -f \"$F\"' EXIT\n" +
    "IFS= read -r token\n" +
    "printf '%s' \"Authorization: Bearer ${token}\" > \"$F\"\n" +
    "curl -sS --max-time " + maxTime + " -X POST " +
    "-H 'Content-Type: application/json' -H '@'\"$F\" " +
    (includeOutput ? "" : "-o /dev/null ") +
    "'" + escapedUrl + "/api' " +
    "-d '" + escapedBody + "'\n"
}

function buildArgs(url, token, command, args, messageId) {
  var body = {
    message_id: messageId !== undefined ? messageId : "omarchy-" + (counter++),
    command: command,
    args: args || {}
  }
  // Return an object so the caller can pipe the token over stdin instead of
  // passing it as an argv element.
  return {
    script: _buildCurlScript(url, JSON.stringify(body), "10", true),
    token: token
  }
}

function buildPlayArgs(url, token, command, args, messageId) {
  var body = {
    message_id: messageId !== undefined ? messageId : "omarchy-play-" + (counter++),
    command: command,
    args: args || {}
  }
  return {
    script: _buildCurlScript(url, JSON.stringify(body), "8", false),
    token: token
  }
}

function isPlaying(player) {
  if (!player) return false
  return player.playback_state === "playing"
}

function isPaused(player) {
  return player && player.playback_state === "paused"
}

function displayName(player) {
  if (!player) return ""
  if (player.group_members && player.group_members.length > 1) {
    var names = [player.name]
    for (var i = 0; i < player.group_members.length; i++) {
      var m = player.group_members[i]
      if (m !== player.player_id) names.push(m)
    }
    return names.join(" + ")
  }
  return player.name || player.player_id || ""
}

function volumePercent(player) {
  if (!player || player.volume_level === undefined || player.volume_level === null) return 100
  return Math.round(player.volume_level)
}

function trackTitle(media) {
  return (media && media.title) ? media.title : ""
}

function trackArtist(media) {
  if (!media) return ""
  if (media.artist) return media.artist
  return ""
}

function trackAlbum(media) {
  return (media && media.album) ? media.album : ""
}

function trackImageUrl(media) {
  return (media && media.image_url) ? media.image_url : ""
}

function pickActivePlayerId(players, preferredId) {
  if (!players || players.length === 0) return ""
  if (preferredId) {
    for (var i = 0; i < players.length; i++) {
      if (players[i].player_id === preferredId && players[i].available) return players[i].player_id
    }
  }
  for (var j = 0; j < players.length; j++) {
    var p = players[j]
    if (!p.available || p.hide_in_ui) continue
    if (p.playback_state === "playing") return p.player_id
  }
  for (var k = 0; k < players.length; k++) {
    var pp = players[k]
    if (pp.available && !pp.hide_in_ui) return pp.player_id
  }
  return players[0].player_id
}

function providerLabel(slug) {
  if (!slug) return ""
  var s = String(slug).toLowerCase()
  var dashIdx = s.indexOf("--")
  if (dashIdx !== -1) s = s.substring(0, dashIdx)
  var map = {
    tidal: "Tidal",
    apple_music: "Apple Music",
    spotify: "Spotify",
    youtube_music: "YouTube Music",
    qobuz: "Qobuz",
    deezer: "Deezer",
    soundcloud: "SoundCloud",
    pandora: "Pandora",
    tunein: "TuneIn",
    radio_browser: "Radio Browser",
    radio_paradise: "Radio Paradise",
    soma_fm: "SomaFM",
    nts: "NTS",
    phishin: "Phish.in",
    nugs: "Nugs.net",
    podcast_index: "Podcast Index",
    audible: "Audible",
    audiobookshelf: "Audiobookshelf",
    filesystem: "Local Files",
    builtin: "Built-in",
    library: "Library",
    siriusxm: "SiriusXM",
    vban: "VBAN",
    snapcast: "Snapcast",
    chromecast: "Chromecast",
    dlna: "DLNA",
    airplay: "AirPlay"
  }
  return map[s] || s
}

function providerDomain(item) {
  if (!item) return ""
  if (item.provider_mappings && item.provider_mappings.length > 0 && item.provider_mappings[0].provider_domain)
    return item.provider_mappings[0].provider_domain
  return item.provider || ""
}

function providerInstanceName(item) {
  if (!item) return ""
  if (item.provider_mappings && item.provider_mappings.length > 0 && item.provider_mappings[0].provider_instance)
    return item.provider_mappings[0].provider_instance
  return ""
}

function mediaTypeLabel(t) {
  if (!t) return ""
  var map = {
    track: "Track",
    album: "Album",
    playlist: "Playlist",
    artist: "Artist",
    radio: "Radio"
  }
  return map[t] || t
}

function repeatModeIcon(mode) {
  if (mode === "one") return ""
  if (mode === "all") return ""
  return ""
}

function repeatModeLabel(mode) {
  if (mode === "one") return "Repeat one"
  if (mode === "all") return "Repeat all"
  return "Repeat off"
}

function shuffleIcon(enabled) {
  return enabled ? "" : ""
}

function formatRelativeTime(epochSeconds) {
  if (!epochSeconds || epochSeconds <= 0) return ""
  var now = Math.floor(Date.now() / 1000)
  var delta = now - epochSeconds
  if (delta < 60) return delta + "s ago"
  if (delta < 3600) return Math.floor(delta / 60) + " min ago"
  if (delta < 86400) return Math.floor(delta / 3600) + " h ago"
  if (delta < 604800) return Math.floor(delta / 86400) + " d ago"
  return new Date(epochSeconds * 1000).toLocaleDateString()
}

function parseEvent(message) {
  try {
    var obj = JSON.parse(String(message || "{}"))
    return {
      event: obj.event || "",
      objectId: obj.object_id || obj.data || null,
      data: obj.data || null
    }
  } catch (e) {
    return { event: "", objectId: null, data: null }
  }
}

function providerInstanceLabel(item) {
  if (!item) return ""
  if (item.provider_mappings && item.provider_mappings.length > 0 && item.provider_mappings[0].provider_instance) {
    return item.provider_mappings[0].provider_instance
  }
  return ""
}