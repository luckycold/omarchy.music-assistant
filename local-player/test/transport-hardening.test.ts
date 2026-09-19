import test from 'node:test';
import assert from 'node:assert/strict';
import { WebRTCTransport } from '../src/vendor/frontend/webrtc-transport.js';

const make = (): any => new WebRTCTransport({ signalingServerUrl: 'wss://invalid', remoteId: 'test', reconnect: false, skipCertificateVerification: true });
const deferred = () => { let resolve!: (v?: any) => void; const promise = new Promise<any>(r => resolve = r); return { promise, resolve }; };
const frame = (id = 1, seq = 0, count = 2, b64 = 'QQ==') => ({ type: '__chunk__', id, seq, count, b64 });

for (const stage of ['signaling', 'request', 'offer', 'local', 'wait']) {
  test(`disconnect during ${stage} cannot resurrect a connection`, async () => {
    const t = make(), gate = deferred(), reached = deferred();
    let peers = 0, offers = 0;
    const pause = async (name: string, value?: any) => { if (name === stage) { reached.resolve(); await gate.promise; } return value; };
    t.signaling = { connect: () => pause('signaling'), requestConnection: () => pause('request', {}), sendOffer: () => offers++, disconnect() {} };
    t.createPeerConnection = () => { peers++; t.peerConnection = { createOffer: () => pause('offer', {}), setLocalDescription: () => pause('local'), close() {} }; };
    t.createDataChannel = () => { t.dataChannel = { close() {} }; };
    t.waitForConnection = () => pause('wait');
    const connecting = t.connect().then(() => null, (e: Error) => e);
    await reached.promise;
    t.disconnect();
    gate.resolve();
    try {
      assert.ok(await connecting instanceof Error, 'canceled connect must reject');
      assert.equal(t.state, 'disconnected');
      assert.equal(t.peerConnection, null);
      assert.equal(t.dataChannel, null);
      assert.equal(t.stableConnectionTimer, null);
      if (stage === 'signaling' || stage === 'request') assert.equal(peers, 0);
      if (stage !== 'wait') assert.equal(offers, 0);
    } finally { t.disconnect(); }
  });
}

test('disconnect cancels the channel-open timeout immediately', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const t = make();
  t.dataChannel = { readyState: 'connecting', close() {} };
  const result = t.waitForConnection().then(() => 'opened', () => 'canceled');
  t.disconnect();
  await Promise.resolve();
  try {
    assert.equal(await Promise.race([result, Promise.resolve('pending')]), 'canceled');
    assert.equal(t.cancelConnectionWait, null);
  } finally { ctx.mock.timers.reset(); }
});

test('late remote description does not mutate a replacement connection', async () => {
  const t = make(), gate = deferred();
  const saved = globalThis.RTCSessionDescription;
  globalThis.RTCSessionDescription = class { constructor(v: any) { Object.assign(this, v); } } as any;
  t.peerConnection = { setRemoteDescription: () => gate.promise, close() {} };
  const answer = t.handleAnswer({ type: 'answer', sdp: '' });
  t.disconnect();
  t.peerConnection = { close() {} };
  gate.resolve();
  try { await answer; assert.equal(t.remoteDescriptionSet, false); }
  finally { t.disconnect(); globalThis.RTCSessionDescription = saved; }
});

test('server-info stays on the API channel without opening unused http_proxy', async () => {
  const t = make(), opened: string[] = [], delivered: string[] = [];
  t.peerConnection = {
    connectionState: 'connected',
    createDataChannel(label: string) { opened.push(label); return { readyState: 'open', close() {} }; },
    close() {},
  };
  t.createDataChannel();
  t.on('message', (data: string) => delivered.push(data));
  const info = JSON.stringify({ server_id: 'test', schema_version: 49 });
  try {
    t.dataChannel.onmessage({ data: info });
    await Promise.resolve();
    assert.deepEqual(delivered, [info]);
    assert.deepEqual(opened, ['ma-api']);
  } finally { t.disconnect(); }
});

test('chunk group flood is bounded and disconnect releases buffers/timer', () => {
  const t = make();
  try {
    for (let id = 0; id < 1000; id++) t.handleChunk(frame(id), () => {});
    assert.ok(t.chunkGroups.size <= 32);
  } finally { t.disconnect(); }
  assert.equal(t.chunkGroups.size, 0);
  assert.equal(t.chunkExpiryTimer, null);
});

test('malformed chunks are dropped without escaping or normal dispatch', () => {
  const t = make(), channel: any = {}, delivered: any[] = [];
  t.attachMessageHandler(channel, (s: any) => delivered.push(s));
  try {
    for (const patch of [{count: -1}, {count: 1.5}, {count: 1025}, {seq: -1}, {seq: 2}, {id: -1}, {id: 'x'}, {b64: '!'}, {b64: null}]) {
      channel.onmessage({data: JSON.stringify({...frame(), ...patch})});
    }
    channel.onmessage({data: JSON.stringify(frame(2, 0, 1, '!'))});
    assert.equal(t.chunkGroups.size, 0);
    assert.deepEqual(delivered, []);
    channel.onmessage({data: 'normal'});
    assert.deepEqual(delivered, ['normal']);
  } finally { t.disconnect(); }
});

test('chunk reassembly supports reordered UTF-8 and ignores duplicate frames', () => {
  const t = make(), out: string[] = [], dispatch = (s: string) => out.push(s);
  try {
    t.handleChunk(frame(1, 1, 2, 'rA=='), dispatch);
    t.handleChunk(frame(1, 1, 2, 'rA=='), dispatch);
    t.handleChunk(frame(1, 0, 2, '4oI='), dispatch);
    assert.deepEqual(out, ['€']);
    assert.equal(t.chunkGroups.size, 0);
  } finally { t.disconnect(); }
});

test('conflicting counts discard the group', () => {
  const t = make(), out: string[] = [], dispatch = (s: string) => out.push(s);
  try { t.handleChunk(frame(), dispatch); t.handleChunk(frame(1, 1, 3), dispatch); assert.equal(t.chunkGroups.size, 0); assert.equal(out.length, 0); }
  finally { t.disconnect(); }
});

test('aggregate chunk buffering and assembled messages cannot exceed 8 MiB', () => {
  const t = make(), out: string[] = [], dispatch = (s: string) => out.push(s);
  const b64 = Buffer.alloc(16384, 65).toString('base64');
  try {
    for (let seq = 0; seq < 513; seq++) t.handleChunk(frame(1, seq, 513, b64), dispatch);
    assert.deepEqual(out, []);
    assert.equal(t.chunkGroups.size, 0);
    for (let id = 0; id < 32; id++) for (let seq = 0; seq < 17; seq++) t.handleChunk(frame(id, seq, 100, b64), dispatch);
    const bytes = [...t.chunkGroups.values()].reduce((n: number, g: any) => n + g.parts.reduce((m: number, p: string) => m + (p ? Buffer.from(p, 'base64').length : 0), 0), 0);
    assert.ok(bytes <= 8 * 1024 * 1024);
  } finally { t.disconnect(); }
});

test('incomplete chunks expire even without more traffic', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const t = make();
  try {
    t.handleChunk(frame(), () => {});
    ctx.mock.timers.tick(31000);
    assert.equal(t.chunkGroups.size, 0);
    assert.equal(t.chunkExpiryTimer, null);
  } finally { t.disconnect(); ctx.mock.timers.reset(); }
});
