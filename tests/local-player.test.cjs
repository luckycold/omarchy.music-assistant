const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../Service.qml'), 'utf8');
function schema(config) {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ConfigSchema.js'), 'utf8').replace('.pragma library', ''), ctx);
  return ctx.parse(JSON.stringify(config));
}
function method(name, root, extra = {}) {
  const m = source.match(new RegExp('  function ' + name + '\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}'));
  assert.ok(m, `missing root method ${name}`);
  return vm.runInContext(`(function(${m[1]}) {${m[2]}\n})`, vm.createContext({root, ...extra}));
}
const oldConfig = {url: 'https://ma.example', token: 'SECRET'};

test('local player defaults off; remote-only config needs a valid Remote ID', () => {
  assert.equal(schema(oldConfig).config.localPlayer.enabled, false);
  assert.equal(schema({token: 'SECRET', localPlayer: {enabled: true, remoteId: 'AAAAAAAAAAAAAAAAAAAAAAAAAA'}}).error, '');
  assert.notEqual(schema({...oldConfig, localPlayer: {enabled: true, remoteId: 'id', signalingUrl: 'http://bad'}}).error, '');
});

test('remote requests never put secrets or LAN URLs on argv', () => {
  const root = {localPlayerEnabled: true, localPlayerExecutable: '/home/test/.local/bin/omarchy-ma-player', requestEpoch: 7, config: oldConfig};
  const payload = method('buildRequest', root, {MaApi: {buildArgs() { assert.fail('LAN fallback'); }}})('music/search', {search_query: 'q'}, 'search');
  assert.equal(JSON.stringify(payload.command), JSON.stringify([root.localPlayerExecutable, 'request']));
  assert.equal(payload.stdin, JSON.stringify({command: 'music/search', args: {search_query: 'q'}}) + '\n');
});

test('controller-only requests keep the token on stdin', () => {
  const payload = method('buildRequest', {localPlayerEnabled: false, requestEpoch: 1, config: oldConfig},
    {MaApi: {buildArgs: () => ({script: 'curl script', token: 'SECRET'})}, Quickshell: {env: () => ''}})('players/all', {});
  assert.equal(payload.stdin, 'SECRET\n');
});

test('helper failure clears in-flight state', () => {
  const root = {requestEpoch: 2, connected: true, players: [1], queue: [1], localPlayerEnabled: true};
  method('requestFailed', root)('HELPER_REQUEST_FAILED');
  assert.equal(root.connected, false);
  assert.equal(root.players.length, 0);
  assert.equal(root.requestEpoch, 3);
});

test('play here selects the laptop without transferring a queue', () => {
  let starts = 0;
  const root = {localPlayerEnabled: true, localPlayerReady: false, localControlBusy: false,
    startLocalPlayer: () => { starts++; return 'ok'; }, selectLocalPlayer() {}};
  const fn = method('playHere', root);
  fn();
  assert.equal(starts, 1);
  assert.doesNotMatch(fn.toString(), /transferQueue|play_media/);
});

test('status is not ready without phase, identity, and a clean error', () => {
  const decode = method('decodeLocalStatus', {});
  const id = 'a'.repeat(43);
  assert.equal(decode(JSON.stringify({phase: 'ready', ready: true, playerId: id}), 0).ready, true);
  assert.equal(decode(JSON.stringify({phase: 'ready', ready: true, playerId: id, error: 'AUTH_FAILED'}), 0).ready, false);
});

test('config saves put credentials on stdin', () => {
  const script = method('configSaveScript', {})('/tmp/config.json', '{"token":"TOP_SECRET"}');
  assert.ok(!script.includes('TOP_SECRET'));
  assert.match(script, /umask 077/);
});

test('unready helper never falls back to LAN and hung requests do not succeed', () => {
  const root = {ready: true, localPlayerEnabled: true, localPlayerReady: false};
  let calls = 0;
  assert.equal(method('runMaRequest', root)({enqueue() { calls++; }}, {command: ['request']}), false);
  assert.equal(calls, 0);
  const replies = [], completions = [], failures = [];
  const reqRoot = {requestEpoch: 1, decodeReply: (text, code) => { if (code !== 0) throw Error('failed'); return JSON.parse(text).result; },
    requestFailed: code => { failures.push(code); reqRoot.requestEpoch++; }};
  const ctx = vm.createContext({root: reqRoot, jobs: [], job: null, busy: false, processExited: false, streamDone: false,
    timedOut: false, exitCode: -1, exitStatus: 0, running: false, stdinEnabled: false, command: [],
    stdout: {text: '{"result":42}'}, requestTimeout: {restart() {}, stop() {}},
    Qt: {callLater() {}}, signal: code => { ctx.killed = code; },
    handleReply: result => replies.push(result), completed: (...args) => completions.push(args)});
  ctx.request = ctx;
  for (const name of ['enqueue', 'drain', 'finish', 'expire']) {
    const match = source.match(new RegExp('    function ' + name + '\\(([^)]*)\\) \\{([\\s\\S]*?)\\n    \\}'));
    ctx[name] = vm.runInContext(`(function(${match[1]}) {${match[2]}\n})`, ctx);
  }
  ctx.enqueue({epoch: 1, command: ['hung'], stdin: '', local: true});
  ctx.expire();
  assert.equal(ctx.killed, 9);
  ctx.running = false;
  ctx.expire();
  assert.deepEqual(replies, []);
  assert.deepEqual(failures, ['HELPER_REQUEST_FAILED']);
});
