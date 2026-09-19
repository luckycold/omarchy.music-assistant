const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const file = path.join(__dirname, '..', 'MaData.js');
const ctx = vm.createContext({});
if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8').replace(/^\.pragma library\s*/, ''), ctx);
const map = (name, value) => {
  assert.equal(typeof ctx[name], 'function', `${name} must be implemented`);
  return JSON.parse(JSON.stringify(ctx[name](value)));
};
test('service consumes tested nested data mappers for media and queue', () => {
  const source=fs.readFileSync(path.join(__dirname,'../Service.qml'),'utf8');
  assert.match(source,/import "MaData.js" as MaData/);
  assert.match(source,/MaData\.queueItem\(it\)/);
  assert.match(source,/return MaData\.mediaItem\(it\)/);
});
const image = (path, remotely_accessible = true) => ({type: 'thumb', path, provider: 'builtin', remotely_accessible});
// Shape follows music-assistant/models 1.1.205 QueueItem and Track/ItemMapping.
const track = () => ({uri: 'library://track/42', item_id: '42', provider: 'library', media_type: 'track', name: 'Song',
  artists: [{name: 'Artist A'}, {name: 'Artist B'}], album: {name: 'Album'}, duration: 241, track_number: 3,
  metadata: {images: [{...image('https://cdn.example/banner.jpg'), type: 'fanart'}, image('https://cdn.example/cover.jpg')]}});

test('media preserves library identity and flattens nested display fields', () => {
  assert.deepEqual(map('mediaItem', track()), {uri: 'library://track/42', item_id: '42', provider: 'library', media_type: 'track',
    name: 'Song', title: 'Song', artist: 'Artist A, Artist B', album: 'Album', image_url: 'https://cdn.example/cover.jpg', duration: 241, track_number: 3});
});
test('queue uses nested identity/title and top-level queue summary', () => {
  const out = map('queueItem', {queue_item_id: 'queue-42', name: 'Artist A - Song', duration: 240, image: image('https://cdn.example/queue.jpg'), media_item: track()});
  assert.equal(out.queue_item_id, 'queue-42');
  assert.equal(out.uri, 'library://track/42');
  assert.equal(out.item_id, '42');
  assert.equal(out.media_type, 'track');
  assert.equal(out.title, 'Song');
  assert.equal(out.name, 'Artist A - Song');
  assert.equal(out.artist, 'Artist A, Artist B');
  assert.equal(out.album, 'Album');
  assert.equal(out.duration, 240);
  assert.equal(out.image_url, 'https://cdn.example/queue.jpg');
});
test('queue handles missing media, retains zero duration and never invents URI', () => {
  const out = map('queueItem', {queue_item_id: 'q1', name: 'Radio', duration: 0, media_item: null});
  assert.equal(out.uri, ''); assert.equal(out.title, 'Radio'); assert.equal(out.duration, 0);
  assert.equal(map('queueItem', {media_item: track(), duration: null}).duration, 241);
});
test('malformed JSON values produce bounded primitive fields without object strings', () => {
  for (const value of [null, undefined, [], false, 4, 'oops', {}, {name: {}, uri: [], item_id: {}, artists: [null, {}, {name: {}}, {name: 'OK'}], album: {}, metadata: {images: [null, {}, 5]}, duration: '5', track_number: -1}]) {
    for (const fn of ['mediaItem', 'queueItem']) {
      const out = map(fn, value);
      assert.ok(!JSON.stringify(out).includes('[object Object]'));
      assert.ok(Object.values(out).every(v => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))));
    }
  }
});
test('summary image descriptor is usable, non-direct descriptors are not', () => {
  assert.equal(map('mediaItem', {image: image('https://cdn.example/a.jpg')}).image_url, 'https://cdn.example/a.jpg');
  for (const p of ['file:///a', 'javascript:alert(1)', 'data:image/png;base64,a', '/local/a', '//cdn.example/a', 'https://user:pass@cdn.example/a', 'https://127.0.0.1/a', 'http://192.168.1.2/a', 'http://10.1.2.3/a', 'http://172.16.0.1/a', 'http://localhost/a', 'http://ma.local/a', 'http://[::1]/a', 'https://cdn.example/a\nb', 'http://2130706433/a', 'http://0x7f000001/a']) {
    assert.equal(map('mediaItem', {image: image(p)}).image_url, '', p);
  }
  assert.equal(map('mediaItem', {image: image('https://cdn.example/a', false)}).image_url, '');
  assert.equal(map('mediaItem', {image: {path: 'https://cdn.example/a'}}).image_url, '');
});
test('invalid summary image falls back to safe thumbnail metadata', () => {
  const it = track(); it.image = image('file:///bad');
  assert.equal(map('mediaItem', it).image_url, 'https://cdn.example/cover.jpg');
});
test('caps strings, collection inspection and numeric values without changing input', () => {
  const it = track(); it.name = '<b>' + 'x'.repeat(10000); it.uri = 'x'.repeat(10000);
  it.artists = Array.from({length: 1000}, () => ({name: 'y'.repeat(10000)}));
  it.duration = Infinity; it.track_number = -5;
  const before = JSON.stringify(it); const out = map('mediaItem', it);
  assert.ok(out.name.length <= 512); assert.ok(out.artist.length <= 512); assert.ok(out.uri.length <= 2048);
  assert.equal(out.duration, 0); assert.equal(out.track_number, 0); assert.equal(JSON.stringify(it), before);
  assert.ok(out.name.startsWith('<b>')); // Consumers MUST render with Text.PlainText.
  const numeric = map('mediaItem', {item_id: 42, duration: 9e20, track_number: 9e20});
  assert.equal(numeric.item_id, '42'); assert.ok(numeric.duration <= 31536000); assert.ok(numeric.track_number <= 1000000);
});
