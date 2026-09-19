.pragma library

var DEFAULTS = {
  url: "",
  token: "",
  preferredPlayerId: "",
  pollIntervalMs: 2000,
  searchLimit: 20,
  recentLimit: 50,
  showSourceBadge: true,
  openWebUiPath: "",
  installMediaKeys: true,
  mprisFallback: true
}

var INTEGER_KEYS = {
  pollIntervalMs: true,
  searchLimit: true,
  recentLimit: true
}

var BOOL_KEYS = {
  showSourceBadge: true,
  installMediaKeys: true,
  mprisFallback: true
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function coerce(raw, key) {
  if (raw === undefined || raw === null) return DEFAULTS[key]
  if (BOOL_KEYS[key]) return !!raw
  if (INTEGER_KEYS[key]) {
    var n = parseInt(raw, 10)
    return isNaN(n) ? DEFAULTS[key] : n
  }
  return String(raw)
}

function parse(text) {
  var parsed = {}
  try {
    if (text && String(text).trim().length > 0) {
      parsed = JSON.parse(String(text))
    }
  } catch (e) {
    return { config: Object.assign({}, DEFAULTS), error: "JSON parse: " + e.message }
  }
  if (!isPlainObject(parsed)) {
    return { config: Object.assign({}, DEFAULTS), error: "config root must be object" }
  }
  var merged = Object.assign({}, DEFAULTS)
  for (var k in DEFAULTS) {
    if (parsed[k] !== undefined) merged[k] = coerce(parsed[k], k)
  }
  for (var k2 in parsed) {
    if (!(k2 in DEFAULTS)) merged[k2] = parsed[k2]
  }
  // Nested defaults are new objects for every parse, never coerced to strings.
  var local = parsed.localPlayer
  var localError = ""
  merged.localPlayer = { enabled: false, remoteId: "", signalingUrl: "wss://signaling.music-assistant.io/ws", name: "This device", forceRelay: false }
  if (local !== undefined) {
    if (!isPlainObject(local)) localError = "localPlayer must be object"
    else {
      if (local.enabled !== undefined && typeof local.enabled !== "boolean") localError = "localPlayer.enabled must be boolean"
      else if (local.enabled !== undefined) merged.localPlayer.enabled = local.enabled
      for (var key of ["remoteId", "signalingUrl", "name"]) {
        if (local[key] === undefined) continue
        if (typeof local[key] !== "string") localError = "localPlayer." + key + " must be string"
        else merged.localPlayer[key] = local[key]
      }
      if (local.forceRelay !== undefined && typeof local.forceRelay !== "boolean") localError = "localPlayer.forceRelay must be boolean"
      else if (local.forceRelay !== undefined) merged.localPlayer.forceRelay = local.forceRelay
      var lp = merged.localPlayer
      if (lp.remoteId && !/^[A-Z3-79]{25}[AEIMQUY4]$/.test(lp.remoteId)) localError = "invalid localPlayer.remoteId"
      if (!/^wss:\/\/[^\s@?#]+(?:\/[^\s?#]*)?$/.test(lp.signalingUrl)) localError = "localPlayer.signalingUrl must be a secure wss URL"
      if (!lp.name.trim() || lp.name.length > 80 || /[\x00-\x1f\x7f]/.test(lp.name)) localError = "invalid localPlayer.name"
      if (lp.enabled && !lp.remoteId) localError = "missing localPlayer.remoteId"
    }
  }
  var error = localError
  if (error) return { config: merged, error: error }
  if (!merged.localPlayer.enabled && (!merged.url || String(merged.url).length === 0)) error = "missing url"
  else if (!merged.token || String(merged.token).length === 0) error = "missing token"
  else if (merged.pollIntervalMs < 500) error = "pollIntervalMs too low (min 500)"
  return { config: merged, error: error }
}
