import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.ts';
import { sanitizeStatus } from '../src/protocol.ts';
import { PlayerError } from '../src/errors.ts';
import { FakeTransport, memoryStorage } from './helpers.ts';
const config = {token:'auth-secret',remoteId:'AAAAAAAAAAAAAAAAAAAAAAAAAA',signalingUrl:'wss://signaling.music-assistant.io/ws'};
function setup(options: {auth?: boolean; sdkError?: boolean; unavailable?: boolean; forceRelay?: boolean} = {}) {
  const t = new FakeTransport(); const order: string[] = []; let sdkOptions: any; let remoteOptions: any;
  t.responder = msg => { order.push(msg.command);
    if (msg.command === 'auth') t.reply(msg,{authenticated: options.auth !== false, token:'do-not-expose'});
    else if (msg.command === 'players/get') t.reply(msg,{player_id:'public-player-id',available:!options.unavailable,token:'do-not-expose',private_key:'hidden'});
    else t.reply(msg,null);
  };
  const player = {clientId:'public-player-id', pairingToken:'pair-secret', isConnected:true, isPlaying:false,
    unlock: async () => {order.push('unlock');}, connect: async () => {order.push('sdk-connect'); if(options.sdkError) throw Error('auth-secret pair-secret');},
    disconnect: () => {order.push('sdk-disconnect');}, timeSyncInfo:{synced:true,offset:0,error:0}, currentFormat:null};
  const spike = createSession({...config,name:'Laptop',forceRelay:options.forceRelay??false}, {storage:memoryStorage(),
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
  assert.equal(s.sdkOptions.webSocket.readyState,1); assert.equal(s.spike.status().playerId,'public-player-id');
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
    const s = createSession(bad, {storage:memoryStorage(),createTransport:()=>{throw Error('must not run');},createPlayer:()=>{throw Error('must not run');}});
    await assert.rejects(s.connect(), /CONFIG_INVALID/);
  }
});
test('SDK-initiated socket closure fails ready session instead of reporting stale readiness', async () => {
  const s = setup(); await s.spike.connect(); s.sdkOptions.webSocket.close();
  assert.equal(s.spike.status().phase,'failed'); assert.equal(s.spike.status().error,'SENDSPIN_CLOSED');
});
for (const branch of ['rpc','unavailable','mismatch','sdk-closed','api-closed','stats'] as const) {
  test(`health diagnostics: ${branch}, safe and persistent across reconnect`, async () => {
    const s=setup(); await s.spike.connect(); const responder=s.t.responder;
    if(branch==='rpc') s.t.responder=msg=>s.t.emit('message',JSON.stringify({message_id:msg.message_id,error_code:42,details:'auth-secret'}));
    if(branch==='unavailable'||branch==='mismatch') s.t.responder=msg=>s.t.reply(msg,{player_id:branch==='mismatch'?'secret-id':'public-player-id',available:branch!=='unavailable',token:'auth-secret'});
    if(branch==='sdk-closed') s.player.isConnected=false;
    if(branch==='api-closed') s.t.responder=()=>s.t.emit('close','auth-secret');
    if(branch==='stats') (s.t as any).connectionStats=async()=>{throw new PlayerError('RPC_TIMEOUT');};
    await assert.rejects(s.spike.health());
    const status=s.spike.status(); const diagnostic=(status as any).lastHealthFailure;
    assert.ok(diagnostic); assert.equal(status.error,branch==='api-closed'?'API_CLOSED':'HEALTH_FAILED');
    assert.equal(diagnostic.stage,branch==='stats'?'transport-stats':['rpc','api-closed'].includes(branch)?'players-get':'player-check');
    assert.equal(diagnostic.code,branch==='rpc'?'RPC_REMOTE':branch==='api-closed'?'RPC_CLOSED':branch==='stats'?'RPC_TIMEOUT':'HEALTH_FAILED');
    assert.ok(Number.isSafeInteger(diagnostic.elapsedMs)&&diagnostic.elapsedMs>=0&&diagnostic.elapsedMs<=2147483647);
    if(branch==='rpc') assert.equal(diagnostic.remoteCode,42);
    if(diagnostic.stage==='player-check') assert.deepEqual([diagnostic.idMatches,diagnostic.available,diagnostic.sdkConnected],[branch!=='mismatch',branch!=='unavailable',branch!=='sdk-closed']);
    for(const secret of ['auth-secret','secret-id','public-player-id','pair-secret']) assert.ok(!JSON.stringify(diagnostic).includes(secret));
    s.t.responder=responder;s.player.isConnected=true;delete (s.t as any).connectionStats;
    await s.spike.connect();await s.spike.health();
    assert.equal(s.spike.status().ready,true);
    assert.deepEqual((sanitizeStatus(s.spike.status()) as any).lastHealthFailure,diagnostic);
    diagnostic.code='auth-secret';assert.notEqual((s.spike.status() as any).lastHealthFailure.code,'auth-secret');
    s.spike.disconnect();
  });
}
test('stats deadline remains 3000ms and records monotonic elapsed time',async ctx=>{
  const s=setup();await s.spike.connect();
  ctx.mock.timers.enable({apis:['setTimeout']});
  let now=100;ctx.mock.method(performance,'now',()=>now);
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  (s.t as any).connectionStats=()=>{entered();return new Promise(()=>{});};
  const health=s.spike.health();const rejected=assert.rejects(health,/HEALTH_FAILED/);
  await started;ctx.mock.timers.tick(2999);await Promise.resolve();assert.equal(s.spike.status().ready,true);
  now=3100;ctx.mock.timers.tick(1);await rejected;
  assert.deepEqual((s.spike.status() as any).lastHealthFailure,{stage:'transport-stats',elapsedMs:3000,code:'HEALTH_FAILED'});
  assert.equal(s.spike.status().error,'HEALTH_FAILED');assert.equal(s.t.connected,false);
  s.spike.disconnect();
});
test('raw stats rejection records no message, payload, or arbitrary error code',async()=>{
  const s=setup();await s.spike.connect();
  (s.t as any).connectionStats=async()=>{throw Object.assign(Error('auth-secret'),{code:'pair-secret',payload:config});};
  await assert.rejects(s.spike.health(),/CONNECT_FAILED/);
  const failure=(s.spike.status() as any).lastHealthFailure;
  assert.equal(failure.stage,'transport-stats');assert.equal(failure.code,'CONNECT_FAILED');
  assert.deepEqual(Object.keys(failure).sort(),['code','elapsedMs','stage']);
  assert.ok(!JSON.stringify(failure).includes('secret'));s.spike.disconnect();
});
test('health diagnostic status allowlist rejects secrets and malformed fields',()=>{
  const clean=(sanitizeStatus({lastHealthFailure:{stage:'player-check',elapsedMs:Infinity,code:'auth-secret',remoteCode:'auth-secret',idMatches:'secret',available:true,sdkConnected:false,message:'secret',payload:{token:'secret'},playerId:'secret'}}) as any).lastHealthFailure;
  assert.deepEqual(clean,{stage:'player-check',elapsedMs:0,code:'INTERNAL',idMatches:false,available:true,sdkConnected:false});
  for(const stage of ['secret',undefined]) assert.equal((sanitizeStatus({lastHealthFailure:{stage}}) as any).lastHealthFailure,null);
  for(const remoteCode of [1.5,NaN,Infinity,'secret']) assert.ok(!('remoteCode' in (sanitizeStatus({lastHealthFailure:{stage:'players-get',elapsedMs:1,code:'RPC_REMOTE',remoteCode}}) as any).lastHealthFailure));
});
test('public RPC requires ready state and refuses authentication/pairing commands', async () => {
  const s = setup(); await assert.rejects(s.spike.rpc('players/get'),/NOT_READY/); await s.spike.connect();
  await assert.rejects(s.spike.rpc('auth',{token:'secret'}),/RPC_RESERVED/);
  await assert.rejects(s.spike.rpc('sendspin/pair_web_player'),/RPC_RESERVED/);
  s.spike.disconnect();
});
