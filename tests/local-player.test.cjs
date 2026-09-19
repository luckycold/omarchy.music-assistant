const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../Service.qml'), 'utf8');
const widget = fs.readFileSync(path.join(__dirname, '../BarWidget.qml'), 'utf8');
function schema(config) {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ConfigSchema.js'), 'utf8').replace('.pragma library', ''), ctx);
  return ctx.parse(JSON.stringify(config));
}
function method(name, root, extra = {}) {
  const m = source.match(new RegExp('  function ' + name + '\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}'));
  assert.ok(m, `missing root method ${name}`);
  const ctx = vm.createContext({root, ...extra});
  return vm.runInContext(`(function(${m[1]}) {${m[2]}\n})`, ctx);
}
const oldConfig = {url: 'https://ma.example', token: 'SECRET'};
test('old controller configs remain disabled; local settings are isolated defaults', () => {
  const a = schema(oldConfig), b = schema(oldConfig);
  assert.equal(a.error, '');
  assert.equal(a.config.localPlayer.enabled, false);
  assert.equal(a.config.localPlayer.name, 'Laptop');
  a.config.localPlayer.name = 'Changed';
  assert.equal(b.config.localPlayer.name, 'Laptop');
});
test('remote-only config validates explicit local fields without requiring LAN URL', () => {
  const config = {token: 'SECRET', localPlayer: {enabled: true, remoteId: 'AAAAAAAAAAAAAAAAAAAAAAAAAA'}};
  assert.equal(schema(config).error, '');
  for (const localPlayer of [null, [], 'yes', {enabled: 'false'}, {enabled: true}, {enabled: true, remoteId: ' id '}, {enabled: true, remoteId: 'id', signalingUrl: 'http://bad'}, {name: 3}]) {
    assert.notEqual(schema({...oldConfig, localPlayer}).error, '', JSON.stringify(localPlayer));
  }
});
test('all RPC constructors use root wrapper, including library and save queue', () => {
  assert.equal((source.match(/MaApi\.buildArgs\(/g) || []).length, 1);
  for (const command of ['players/all', 'player_queues/items', 'music/search', 'player_queues/save_as_playlist', 'music/recently_played_items']) assert.ok(source.includes(command));
});
test('remote request sends command and arguments only on stdin, never LAN or secrets in argv', () => {
  const root = {localPlayerEnabled: true, localPlayerExecutable: '/home/test/.local/bin/omarchy-ma-player', requestEpoch: 7, config: oldConfig};
  const payload = method('buildRequest', root, {MaApi: {buildArgs() {assert.fail('LAN fallback');}}})('music/search', {search_query: 'private query'}, 'search');
  assert.equal(JSON.stringify(payload.command), JSON.stringify([root.localPlayerExecutable, 'request']));
  assert.equal(payload.stdin, JSON.stringify({command: 'music/search', args: {search_query: 'private query'}}) + '\n');
  assert.equal(payload.epoch, 7);
  assert.equal(payload.local, true);
});
test('controller-only requests retain the existing token-over-stdin transport', () => {
  const root = {localPlayerEnabled: false, requestEpoch: 1, config: oldConfig};
  const payload = method('buildRequest', root, {MaApi: {buildArgs: () => ({script: 'curl script', token: 'SECRET'})}, Quickshell: {env: () => ''}})('players/all', {});
  assert.equal(payload.stdin, 'SECRET\n');
  const request = source.slice(source.indexOf('component MaRequest: Process'));
  assert.match(request, /onStarted:\s*\{\s*write\(job.stdin\)\s*job.stdin = ""\s*stdinEnabled = false\s*\}/);
  assert.equal(JSON.stringify(payload.command), JSON.stringify(['/bin/bash', '-c', 'curl script']));
});
test('MPRIS is disabled only when the selected player is the local identity', () => {
  const root = {config: {}, localPlayerSelected: true};
  const fn = method('mprisRoutingEnabled', root);
  assert.equal(fn(), false);
  root.localPlayerSelected = false;
  assert.equal(fn(), true);
  root.config.mprisFallback = false;
  assert.equal(fn(), false);
});
test('helper failure invalidates in-flight replies and clears stale connected/player state', () => {
  const root = {requestEpoch: 2, connected: true, players: [1], queue: [1], localPlayerState: {playerId: 'identity'}, localPlayerEnabled: true};
  method('requestFailed', root)('HELPER_REQUEST_FAILED');
  assert.equal(root.connected, false);
  assert.equal(root.players.length, 0);
  assert.equal(root.queue.length, 0);
  assert.equal(root.pollInFlight, false);
  assert.equal(root.requestEpoch, 3);
});
test('play here starts when needed and selects local only without transferring a queue', () => {
  let starts = 0, selections = 0;
  const root = {localPlayerEnabled: true, localPlayerReady: false, localControlBusy: false, startLocalPlayer: () => { starts++; return 'ok'; }, selectLocalPlayer: () => { selections++; }};
  const fn = method('playHere', root);
  fn();
  assert.equal(starts, 1);
  assert.equal(root.playHerePending, true);
  root.localPlayerReady = true;
  fn();
  assert.equal(selections, 1);
  assert.doesNotMatch(fn.toString(), /transferQueue|play_media/);
});
test('UI has lifecycle controls and disconnected action gating, and IPC exposes local status', () => {
  for (const text of ['Start', 'Stop', 'Restart', 'Play here']) assert.ok(widget.includes(`text: "${text}"`));
  for (const method of ['localPlayerStatus', 'startLocalPlayer', 'stopLocalPlayer', 'restartLocalPlayer', 'playHere']) assert.match(source, new RegExp('function ' + method + '\\([^)]*\\): string'));
  assert.match(widget, /enabled: root\.serviceConnected/);
  assert.match(source, /systemctl", "--user"/);
});
test('status cannot claim ready without ready phase, identity and no error; phases stay useful', () => {
  const decode = method('decodeLocalStatus', {});
  const id = 'a'.repeat(43);
  assert.equal(decode(JSON.stringify({phase:'ready',ready:true,playerId:id}),0).ready,true);
  for (const value of [{phase:'pairing',ready:true,playerId:id}, {phase:'ready',ready:true}, {phase:'ready',ready:true,playerId:id,error:'AUTH_FAILED'}]) {
    assert.equal(decode(JSON.stringify(value),0).ready,false);
  }
  assert.equal(decode(JSON.stringify({phase:'opening-sendspin',ready:false}),0).phase,'opening-sendspin');
  assert.throws(() => decode('{}',0));
  assert.throws(() => decode('{"ready":true,"phase":"ready"}',1));
});
test('response decoding preserves false/null results but rejects helper errors and malformed envelopes', () => {
  const decode = method('decodeReply', {}, {MaApi:{MAX_RESPONSE_BYTES:1024}});
  for (const result of [null,false,0,[],{}]) assert.equal(JSON.stringify(decode(JSON.stringify({result}),0,true)),JSON.stringify(result));
  for (const text of ['', '{}', 'bad JSON', '{"error":"AUTH_FAILED"}', '{"result":[],"error_code":1}']) assert.throws(() => decode(text,0,true));
  assert.throws(() => decode('{"result":[]}',1,true));
  assert.throws(() => decode(' '.repeat(1025),0,true));
});
test('canonical Remote IDs and helper config size constraints are enforced', () => {
  for (const remoteId of ['abc','a'.repeat(26),'B'.repeat(26),'2'.repeat(26)]) assert.notEqual(schema({...oldConfig,localPlayer:{enabled:true,remoteId}}).error,'');
  assert.notEqual(schema({...oldConfig,localPlayer:{name:'x'.repeat(81)}}).error,'');
  assert.notEqual(schema({...oldConfig,localPlayer:{forceRelay:'yes'}}).error,'');
});
test('config persistence sends credentials on stdin and coalesces concurrent saves', () => {
  const script = method('configSaveScript', {})('/tmp/config.json', '{"token":"TOP_SECRET"}');
  assert.ok(!script.includes('TOP_SECRET'));
  assert.match(script, /umask 077/);
  assert.match(script, /mktemp/);
  assert.match(script, /mv -f/);
  assert.match(source, /configSaver\.running/);
  assert.match(source, /write\(saveJson/);
});
test('malformed player list clears stale state rather than throwing from a QML signal', () => {
  let failed = 0;
  const root = {requestFailed: () => {failed++;}};
  const fn = method('applyPlayers', root);
  assert.equal(fn({error:'bad'}),false);
  assert.equal(failed,1);
});
test('request process does not shadow the inherited exited signal', () => {
  assert.doesNotMatch(source, /property bool exited:/);
});
function requestHarness() {
  const later = [], completions = [], replies = [], failures = [];
  const root = {requestEpoch: 1, decodeReply: (text, code) => {
    if (code !== 0) throw Error('failed');
    return JSON.parse(text).result;
  }, requestFailed: code => { failures.push(code); root.requestEpoch++; }};
  const ctx = vm.createContext({root, jobs: [], job: null, busy: false,
    processExited: false, streamDone: false, timedOut: false, exitCode: -1,
    exitStatus: 0, running: false, stdinEnabled: false, command: [],
    stdout: {text: '{"result":42}'},
    requestTimeout: {restart() {}, stop() {}},
    Qt: {callLater: fn => later.push(fn)}, signal: code => {ctx.killed = code;},
    handleReply: result => replies.push(result),
    completed: (...args) => completions.push(args)});
  ctx.request = ctx;
  for (const name of ['enqueue', 'drain', 'finish', 'expire']) {
    const match = source.match(new RegExp('    function ' + name + '\\(([^)]*)\\) \\{([\\s\\S]*?)\\n    \\}'));
    assert.ok(match);
    ctx[name] = vm.runInContext(`(function(${match[1]}) {${match[2]}\n})`, ctx);
  }
  return {ctx, root, later, completions, replies, failures};
}
test('request queue executes real extracted functions for serialization and stale epochs', () => {
  const {ctx, root, later, replies, completions} = requestHarness();
  ctx.enqueue({epoch:1, command:['first'], stdin:''});
  ctx.enqueue({epoch:1, command:['obsolete'], stdin:''});
  assert.equal(ctx.command[0], 'first');
  ctx.streamDone = true; ctx.exitCode = 0;
  ctx.finish();
  assert.equal(ctx.busy, true);
  ctx.processExited = true;
  ctx.finish();
  assert.deepEqual(replies, [42]);
  assert.equal(completions.length, 1);
  assert.equal(ctx.busy, false);
  root.requestEpoch++;
  later.shift()();
  assert.equal(ctx.jobs.length, 0);
  ctx.enqueue({epoch:2, command:['new'], stdin:''});
  root.requestEpoch++;
  ctx.processExited = ctx.streamDone = true;
  ctx.finish();
  assert.equal(replies.length, 1);
  assert.equal(completions.length, 1, 'stale completion must not change status');
});
test('request watchdog kills then recovers missing exit/EOF without applying success', () => {
  const {ctx, failures, replies, completions} = requestHarness();
  ctx.enqueue({epoch:1, command:['hung'], stdin:'', local:true});
  ctx.expire();
  assert.equal(ctx.killed, 9);
  assert.equal(ctx.busy, true);
  ctx.running = false;
  ctx.expire();
  assert.equal(ctx.busy, false);
  assert.deepEqual(replies, []);
  assert.deepEqual(failures, ['HELPER_REQUEST_FAILED']);
  assert.equal(completions[0][0], -1);
});
test('remote mode never invokes media key installer', () => {
  const installer = {running:false};
  method('installMediaKeysBindings', {ready:true, localPlayerEnabled:true, config:{}},
    {mediaKeysInstaller:installer})();
  assert.equal(installer.running, false);
});
test('example config validates and defaults to controller-only mode', () => {
  const result = schema(JSON.parse(fs.readFileSync(path.join(__dirname, '../config.example.json'), 'utf8')));
  assert.equal(result.error, '');
  assert.equal(result.config.localPlayer.enabled, false);
});
test('local queue selection only activates an available local identity', () => {
  const selections = [];
  let available = false;
  const root = {playHerePending:true, localPlayerReady:true, localPlayerId:'local',
    playerById: () => ({available}), activatePlayer: id => selections.push(id)};
  const select = method('selectLocalPlayer', root);
  select();
  assert.equal(root.playHerePending, true);
  assert.deepEqual(selections, []);
  available = true;
  select();
  assert.equal(root.playHerePending, false);
  assert.deepEqual(selections, ['local']);
});
test('helper readiness gates requests with no LAN fallback and queue is bounded', () => {
  const root = {ready:true, localPlayerEnabled:true, localPlayerReady:false};
  let calls = 0;
  const run = method('runMaRequest', root);
  assert.equal(run({enqueue() {calls++;}}, {command: ['request']}), false);
  assert.equal(calls, 0);
  assert.equal(root.lastError, 'LOCAL_PLAYER_NOT_READY');
  const {ctx} = requestHarness();
  ctx.enqueue({epoch:1, command:['active'], stdin:''});
  for (let i=0; i<16; i++) assert.equal(ctx.enqueue({epoch:1, command:['queued'], stdin:''}), true);
  assert.equal(ctx.enqueue({epoch:1, command:['overflow'], stdin:''}), false);
  assert.equal(ctx.jobs.length, 16);
});
