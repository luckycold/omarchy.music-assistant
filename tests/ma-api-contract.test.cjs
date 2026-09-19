const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../Service.qml'), 'utf8');
const MaApi = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../MaApi.js'), 'utf8').replace('.pragma library', ''), MaApi);
function method(name, root, extra = {}) {
  const m = source.match(new RegExp('  function ' + name + '\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}'));
  assert.ok(m, `missing ${name}`);
  return vm.runInNewContext(`(function(${m[1]}) {${m[2]}\n})`, {root, MaApi, ...extra});
}
function reply(id, root) {
  const m = source.match(new RegExp('id: ' + id + '\\n    handleReply: function\\(value, context\\) \\{([\\s\\S]*?)\\n    \\}'));
  return vm.runInNewContext(`(function(value, context) {${m[1]}\n})`, {root, MaApi});
}
function harness() {
  const calls = [];
  const root = {ready: true, connected: true, activePlayerId: 'speaker', activeQueueId: 'group', activeQueuePlayerId: 'speaker',
    queueEpoch: 0, queue: [{uri: 'library://track/1'}], queuePosition: 7, shuffleEnabled: true, repeatMode: 'all',
    playerById: () => ({available: true}), config: {}, persistConfig() {}, refreshState() {},
    runAction: (command, args) => { calls.push({command, args}); return true; },
    buildRequest: (command, args) => ({command, args}), runMaRequest: (proc, payload) => { calls.push(payload); return true; }};
  for (const name of ['actionForPlayer', 'seek', 'seekRelative']) root[name] = method(name, root);
  return {root, calls};
}

test('unresolved local identity fails closed for MPRIS', () => {
  const root = {localPlayerEnabled: true, localPlayerId: '', localPlayerSelected: false, config: {}};
  const route = method('mprisRoutingEnabled', root);
  assert.equal(route(), false);
  root.localPlayerId = 'local';
  assert.equal(route(), true);
  root.localPlayerSelected = true;
  assert.equal(route(), false);
});

test('seek keeps UI milliseconds but sends seconds', () => {
  const {root, calls} = harness();
  root.seek('', 12500);
  assert.equal(JSON.stringify(calls[0]), JSON.stringify({command: 'player_queues/seek', args: {position: 12.5, queue_id: 'group'}}));
});

test('poll resolves the active queue before fetching items', () => {
  const {root, calls} = harness();
  method('runFetchQueue', root, {activeQueueProc: {}, queueProc: {}})('speaker');
  assert.equal(calls[0].command, 'player_queues/get_active_queue');
  root.runFetchQueueItems = method('runFetchQueueItems', root, {queueProc: {}});
  root.applyActiveQueue = method('applyActiveQueue', root);
  reply('activeQueueProc', root)({queue_id: 'leader', current_index: 3}, calls[0].context);
  assert.equal(root.activeQueueId, 'leader');
  assert.equal(calls[1].command, 'player_queues/items');
  assert.equal(calls[1].args.queue_id, 'leader');
});

test('switching players drops the old queue so stale replies cannot retarget', () => {
  const {root, calls} = harness();
  root.resetQueueContext = method('resetQueueContext', root);
  root.setActivePlayer = method('setActivePlayer', root);
  method('activatePlayer', root)('other');
  assert.equal(root.activeQueueId, '');
  root.actionForPlayer('', 'player_queues/pause');
  assert.equal(calls.length, 0);
  root.applyActiveQueue = method('applyActiveQueue', root);
  root.runFetchQueueItems = () => assert.fail('stale queue fetch');
  reply('activeQueueProc', root)({queue_id: 'old'}, {playerId: 'speaker', queueEpoch: 0});
  assert.equal(root.activeQueueId, '');
});

test('actions stay gated until connected and refresh when they complete', () => {
  const {root, calls} = harness();
  const run = method('runAction', root, {actionProc: {}});
  root.connected = false;
  assert.equal(run('player_queues/pause', {}), false);
  root.connected = true;
  assert.equal(run('player_queues/pause', {queue_id: 'group'}), true);
  assert.equal(calls[0].command, 'player_queues/pause');
});

test('favoriteCurrent removes a library track instead of adding again', () => {
  const {root, calls} = harness();
  root.activeMedia = {uri: 'library://track/9', title: 'Song'};
  root.isFavorite = true;
  root.lastError = '';
  root.showOsd = () => {};
  root.refreshFavorites = () => {};
  root.actionForSourceTarget = (command, args) => root.runAction(command, args);
  root.parseLibraryUri = method('parseLibraryUri', root);
  root.favoriteLibraryRef = method('favoriteLibraryRef', root);
  root.addFavorite = method('addFavorite', root);
  root.removeFavorite = method('removeFavorite', root);
  method('favoriteCurrent', root)();
  assert.equal(calls[0].command, 'music/favorites/remove_item');
  assert.equal(JSON.stringify(calls[0].args), JSON.stringify({media_type: 'track', library_item_id: '9'}));
});

test('favoriteCurrent adds when the track is not a favorite', () => {
  const {root, calls} = harness();
  root.activeMedia = {uri: 'library://track/9', title: 'Song'};
  root.isFavorite = false;
  root.showOsd = () => {};
  root.refreshFavorites = () => {};
  root.actionForSourceTarget = (command, args) => root.runAction(command, args);
  root.parseLibraryUri = method('parseLibraryUri', root);
  root.favoriteLibraryRef = method('favoriteLibraryRef', root);
  root.addFavorite = method('addFavorite', root);
  root.removeFavorite = method('removeFavorite', root);
  method('favoriteCurrent', root)();
  assert.equal(calls[0].command, 'music/favorites/add_item');
  assert.equal(calls[0].args.item, 'library://track/9');
});
