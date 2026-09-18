import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpike } from '../src/session.ts';
import { FakeTransport, memoryStorage } from './helpers.ts';
const config = {token:'auth-secret',remoteId:'AAAAAAAAAAAAAAAAAAAAAAAAAA',signalingUrl:'wss://signaling.music-assistant.io/ws'};
function setup(options: {auth?: boolean; sdkError?: boolean; unavailable?: boolean; silentTestUrl?: string} = {}) {
  const t = new FakeTransport(); const order: string[] = []; let sdkOptions: any; let remoteOptions: any;
  t.responder = msg => { order.push(msg.command);
    if (msg.command === 'auth') t.reply(msg,{authenticated: options.auth !== false, token:'do-not-expose'});
    else if (msg.command === 'players/get') t.reply(msg,{player_id:'public-player-id',available:!options.unavailable,token:'do-not-expose',private_key:'hidden'});
    else t.reply(msg,null);
  };
  const player = {clientId:'public-player-id', pairingToken:'pair-secret', isConnected:true, isPlaying:false,
    unlock: async () => {order.push('unlock');}, connect: async () => {order.push('sdk-connect'); if(options.sdkError) throw Error('auth-secret pair-secret');},
    disconnect: () => {order.push('sdk-disconnect');}, timeSyncInfo:{synced:true,offset:0,error:0}, currentFormat:null};
  const spike = createSpike({...config,silentTestUrl:options.silentTestUrl}, {storage:memoryStorage(),
    createTransport: (o: any) => {remoteOptions=o; return t;},
    createPlayer: (o: any) => {sdkOptions=o; return player;}, readinessTimeoutMs:15, pollMs:1});
  return {spike,t,order,player,get sdkOptions(){return sdkOptions;},get remoteOptions(){return remoteOptions;}};
}
test('remote-only route authenticates before channel/SDK/pair/readiness and strips secrets', async () => {
  const s = setup(); const originalOpen = s.t.openDataChannel.bind(s.t);
  s.t.openDataChannel = async (label: string) => {s.order.push('channel'); return originalOpen(label);};
  await s.spike.connect();
  assert.deepEqual(s.order.slice(0,6),['unlock','auth','channel','sdk-connect','sendspin/pair_web_player','players/get']);
  assert.equal(s.remoteOptions.skipCertificateVerification,false); assert.equal(s.remoteOptions.reconnect,false);
  assert.equal(s.remoteOptions.dataChannelLabel,'ma-api'); assert.equal(s.remoteOptions.remoteId,config.remoteId);
  assert.equal(s.sdkOptions.baseUrl,undefined); assert.equal(s.sdkOptions.productName,'Web Player');
  assert.equal(s.sdkOptions.webSocket.readyState,1); assert.equal(s.spike.playerId,'public-player-id');
  const status = s.spike.status(); assert.equal(status.phase,'ready'); assert.equal(status.paired,true);
  for (const secret of ['auth-secret','pair-secret','do-not-expose','hidden',config.remoteId]) assert.ok(!JSON.stringify(status).includes(secret));
  (status as any).phase='tampered'; assert.equal(s.spike.status().phase,'ready'); s.spike.disconnect(); assert.equal(s.spike.status().phase,'disconnected');
});
test('auth failure never opens Sendspin and exposes only static error', async () => {
  const s = setup({auth:false}); await assert.rejects(s.spike.connect(), /AUTH_FAILED/);
  assert.ok(!s.order.includes('sdk-connect')); assert.equal(s.spike.status().phase,'failed'); assert.equal(s.t.connected,false);
});
test('SDK connect and async pairing event errors cannot leak details', async () => {
  const s = setup({sdkError:true}); await assert.rejects(s.spike.connect(), /CONNECT_FAILED/);
  assert.ok(!JSON.stringify(s.spike.status()).includes('secret'));
  const a = setup(); await a.spike.connect(); a.sdkOptions.onPairing('aborted','pair-secret');
  assert.equal(a.spike.status().error,'PAIRING_ABORTED'); assert.equal(a.t.connected,false);
});
test('players/get availability is mandatory and has bounded waiting', async () => {
  const s = setup({unavailable:true}); await assert.rejects(s.spike.connect(), /PLAYER_NOT_READY/);
  assert.equal(s.spike.status().ready,false); assert.equal(s.t.connected,false);
});
test('disconnect during authentication cannot later advance to SDK', async () => {
  const s = setup(); s.t.responder = ()=>{}; const p = s.spike.connect();
  await new Promise(resolve=>setTimeout(resolve,1)); s.spike.disconnect(); await assert.rejects(p);
  assert.ok(!s.order.includes('sdk-connect')); assert.equal(s.spike.status().phase,'disconnected');
});
test('configuration validation rejects insecure signaling and malformed remote IDs', async () => {
  for (const bad of [{...config,signalingUrl:'ws://example.org/ws'}, {...config,remoteId:config.remoteId.toLowerCase()}, {...config,token:''}]) {
    const s = createSpike(bad, {storage:memoryStorage(),createTransport:()=>{throw Error('must not run');},createPlayer:()=>{throw Error('must not run');}});
    await assert.rejects(s.connect(), /CONFIG_INVALID/);
  }
});
test('silent test is opt-in server-reachable URL RPC targeting this player only', async () => {
  const s = setup({silentTestUrl:'https://example.org/silent.wav'}); await s.spike.connect();
  assert.deepEqual(await s.spike.playSilentTest(),{submitted:true});
  assert.deepEqual(s.t.sent.at(-1).args,{queue_id:s.spike.playerId,media:'https://example.org/silent.wav',option:'replace'});
  assert.equal(s.t.sent.at(-1).command,'player_queues/play_media'); s.spike.disconnect();
  const no = setup(); await assert.rejects(no.spike.playSilentTest(),/TEST_URL_REQUIRED/);
  const blob = setup({silentTestUrl:'blob:http://localhost/test'}); await assert.rejects(blob.spike.playSilentTest(),/TEST_URL_REQUIRED/);
});
test('SDK-initiated socket closure fails ready session instead of reporting stale readiness', async () => {
  const s = setup(); await s.spike.connect(); s.sdkOptions.webSocket.close();
  assert.equal(s.spike.status().phase,'failed'); assert.equal(s.spike.status().error,'SENDSPIN_CLOSED');
});
test('public RPC requires ready state and refuses authentication/pairing commands', async () => {
  const s = setup(); await assert.rejects(s.spike.rpc('players/get'),/NOT_READY/); await s.spike.connect();
  await assert.rejects(s.spike.rpc('auth',{token:'secret'}),/RPC_RESERVED/);
  await assert.rejects(s.spike.rpc('sendspin/pair_web_player'),/RPC_RESERVED/);
  s.spike.disconnect();
});
