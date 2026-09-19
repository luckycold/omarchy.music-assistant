.pragma library

// MA 2.10.3 / music-assistant-models 1.1.205. Pure JSON-in, primitives-out.
// Display text is deliberately NOT HTML: bind QML Text.textFormat: Text.PlainText.
// Limits bound output and collection work; no proxy URL or identity is invented.
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, limit) {
  return typeof value === "string" ? value.slice(0, limit || 512) : "";
}

function identifier(value, limit) {
  if (typeof value === "number" && isFinite(value)) value = String(value);
  // Never truncate an actionable identifier into a different identifier.
  return typeof value === "string" && value.length <= limit ? value : "";
}

function number(value, max) {
  return typeof value === "number" && isFinite(value) && value >= 0 ? Math.min(value, max) : 0;
}

function artists(value) {
  if (!Array.isArray(value)) return "";
  var names = [];
  for (var i = 0; i < Math.min(value.length, 32); i++) {
    var name = text(object(value[i]).name);
    if (name) names.push(name);
  }
  return names.join(", ").slice(0, 512);
}

function directImage(value) {
  var image = object(value);
  var url = image.path;
  if (image.remotely_accessible !== true || typeof url !== "string" || url.length > 2048) return "";
  // Conservative DNS-only HTTP(S): reject local names, IP literals/alternative
  // numeric IP notation, credentials, whitespace and parser-confusing escapes.
  // A pure mapper cannot verify DNS, redirects or actual network reachability.
  if (/[\s\u0000-\u001f\u007f\\]/.test(url)) return "";
  var match = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(url);
  if (!match) return "";
  var authority = match[1];
  var hostMatch = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(authority);
  if (!hostMatch) return "";
  if (hostMatch[2] && (+hostMatch[2] < 1 || +hostMatch[2] > 65535)) return "";
  var host = hostMatch[1].toLowerCase();
  if (host.length > 253 || !/\.[a-z]{2,63}$/.test(host)) return "";
  if (/(^|\.)(localhost|local|lan|internal|home|home\.arpa|onion)$/.test(host)) return "";
  var labels = host.split(".");
  for (var i = 0; i < labels.length; i++) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(labels[i])) return "";
  }
  return url;
}

function itemImage(value) {
  var item = object(value);
  var direct = directImage(item.image);
  if (direct) return direct;
  var images = object(item.metadata).images;
  if (!Array.isArray(images)) return "";
  for (var i = 0; i < Math.min(images.length, 32); i++) {
    var image = object(images[i]);
    if (image.type === "thumb") {
      direct = directImage(image);
      if (direct) return direct;
    }
  }
  return "";
}

function splitTitle(name, artist) {
  if (!name || !artist) return name;
  var seps = [" - ", " — ", " – "];
  for (var i = 0; i < seps.length; i++) {
    var prefix = artist + seps[i];
    if (name.indexOf(prefix) === 0 && name.length > prefix.length) return name.slice(prefix.length);
  }
  return name;
}

function mediaItem(value) {
  var item = object(value);
  var artist = artists(item.artists) || text(item.artist) || text(object(item.artist).name);
  var name = splitTitle(text(item.name) || text(item.title), artist);
  return {
    uri: identifier(item.uri, 2048),
    item_id: identifier(item.item_id, 512),
    provider: identifier(item.provider, 256),
    media_type: identifier(item.media_type, 64),
    name: name,
    title: name,
    artist: artist,
    album: text(object(item.album).name) || text(item.album),
    image_url: itemImage(item) || itemImage(object(item.album)),
    duration: number(item.duration, 31536000),
    track_number: Math.floor(number(item.track_number, 1000000))
  };
}

function queueItem(value) {
  var item = object(value);
  var result = mediaItem(item.media_item);
  result.queue_item_id = identifier(item.queue_item_id, 512);
  result.name = result.name || splitTitle(text(item.name), result.artist);
  result.title = result.title || result.name;
  if (typeof item.duration === "number" && isFinite(item.duration) && item.duration >= 0)
    result.duration = number(item.duration, 31536000);
  result.image_url = directImage(item.image) || result.image_url;
  return result;
}
