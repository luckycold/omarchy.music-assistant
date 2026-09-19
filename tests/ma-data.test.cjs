const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'MaData.js'), 'utf8').replace(/^\.pragma library\s*/, ''), ctx);
const map = (name, value) => JSON.parse(JSON.stringify(ctx[name](value)));
const track = () => ({uri: 'library://track/42', item_id: '42', provider: 'library', media_type: 'track', name: 'Song',
  artists: [{name: 'Artist A'}, {name: 'Artist B'}], album: {name: 'Album'}, duration: 241,
  metadata: {images: [{type: 'thumb', path: 'https://cdn.example/cover.jpg', provider: 'builtin', remotely_accessible: true}]}});

test('media and queue flatten nested MA fields', () => {
  assert.deepEqual(map('mediaItem', track()), {uri: 'library://track/42', item_id: '42', provider: 'library', media_type: 'track',
    name: 'Song', title: 'Song', artist: 'Artist A, Artist B', album: 'Album', image_url: 'https://cdn.example/cover.jpg', duration: 241, track_number: 0});
  const q = map('queueItem', {queue_item_id: 'queue-42', name: 'Artist A - Song', duration: 240, media_item: track()});
  assert.equal(q.uri, 'library://track/42');
  assert.equal(q.name, 'Song');
  assert.equal(q.title, 'Song');
  assert.equal(q.artist, 'Artist A, Artist B');
  assert.equal(q.duration, 240);
});

test('combined MASS display names do not duplicate the artist', () => {
  const item = map('mediaItem', {name: 'The Gray Havens - Band of Gold', artists: [{name: 'The Gray Havens'}]});
  assert.equal(item.title, 'Band of Gold');
  assert.equal(item.artist, 'The Gray Havens');
});

test('image URLs reject file, javascript, and local schemes', () => {
  for (const p of ['file:///a', 'javascript:alert(1)', 'data:image/png;base64,a', 'http://127.0.0.1/a']) {
    assert.equal(map('mediaItem', {image: {type: 'thumb', path: p, provider: 'builtin', remotely_accessible: true}}).image_url, '');
  }
});
