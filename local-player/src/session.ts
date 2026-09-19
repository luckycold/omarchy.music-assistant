import { SendspinPlayer, type SendspinPlayerConfig, type SendspinStorage } from '@sendspin/sendspin-js';
import { base32nopad } from '@scure/base';
import { WebRTCTransport, type WebRTCTransportOptions } from './vendor/frontend/webrtc-transport';
import type { ITransport } from './vendor/frontend/transport';
import { RpcClient } from './rpc';
import { ChannelSocket } from './channel-socket';
import {validateRequest, sanitizeHealthFailure, type HealthStage} from './protocol';
import { PlayerError, safeError, type ErrorCode } from './errors';
export interface SessionConfig { token: string; remoteId: string; signalingUrl: string; name?: string; forceRelay?: boolean; }
type Transport = Pick<ITransport, 'connect'|'disconnect'|'send'|'on'|'off'> & {connectionStats?():Promise<{localCandidateType:string|null;receivedBytes:number}>;openDataChannel(label: string): Promise<RTCDataChannel | null>};
type Player = Pick<SendspinPlayer, 'unlock'|'connect'|'disconnect'|'clientId'|'pairingToken'|'isConnected'|'isPlaying'|'timeSyncInfo'|'currentFormat'>;
interface Dependencies {
  storage: SendspinStorage;
  createTransport?: (options: WebRTCTransportOptions) => Transport;
  createPlayer?: (options: SendspinPlayerConfig) => Player;
  readinessTimeoutMs?: number; pollMs?: number;
}
type Phase = 'idle'|'unlocking'|'remote-connecting'|'authenticating'|'opening-sendspin'|'sdk-connecting'|'pairing'|'waiting-player'|'ready'|'failed'|'disconnected';
interface Attempt { abort: AbortController; transport?: Transport; rpc?: RpcClient; socket?: ChannelSocket; player?: Player; }
function validate(config: SessionConfig) {
  try {
    if (typeof config.token !== 'string' || !config.token || !/^[A-Z3-79]{26}$/.test(config.remoteId)) throw 0;
    const decoded = base32nopad.decode(config.remoteId.replace(/9/g,'2'));
    if (decoded.length !== 16 || base32nopad.encode(decoded).replace(/2/g,'9') !== config.remoteId) throw 0;
    const url = new URL(config.signalingUrl);
    if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) throw 0;
  } catch { throw new PlayerError('CONFIG_INVALID'); }
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }
export function createSession(config: SessionConfig, deps: Dependencies) {
  let transportStats={localCandidateType:null as string|null,receivedBytes:0};
  let lastHealthFailure: ReturnType<typeof sanitizeHealthFailure> = null;
  let phase: Phase = 'idle'; let error: ErrorCode | null = null;
  let authenticated = false; let paired = false; let available = false; let playerId: string | null = null;
  let active: Attempt | undefined; let inFlight: Promise<ReturnType<typeof status>> | undefined;
  function status() {
    // Allowlist only: no config, SDK objects, cached server metadata, storage, raw errors or RPC responses.
    return {phase, error, ready: phase === 'ready', authenticated, paired, playerAvailable:available, playerId,
      apiConnected: authenticated && !!active && !active.abort.signal.aborted,
      sendspinConnected: active?.player?.isConnected === true,
      playing: active?.player?.isPlaying === true,
      timeSynced: active?.player?.timeSyncInfo.synced === true,
      codec: ['opus','flac','pcm'].includes(active?.player?.currentFormat?.codec ?? '') ? active!.player!.currentFormat!.codec : null,
      transport:transportStats, channel: active?.socket?.stats() ?? null,
      lastHealthFailure:sanitizeHealthFailure(lastHealthFailure)};
  }
  function cleanup(a: Attempt) {
    if (a.abort.signal.aborted) return;
    a.abort.abort(); a.rpc?.dispose();
    try { a.player?.disconnect('user_request'); } catch { /* no raw SDK errors */ }
    try { a.socket?.close(); } catch { /* continue closing transport */ }
    try { a.transport?.disconnect(); } catch { /* no raw transport errors */ }
  }
  function fail(a: Attempt, code: ErrorCode) {
    if (active !== a || a.abort.signal.aborted) return;
    error = code; phase = 'failed'; authenticated = false; paired = false; available = false;
    cleanup(a);
  }
  function ensure(a: Attempt) { if (active !== a || a.abort.signal.aborted) throw new PlayerError(error ?? 'CANCELLED'); }
  // Cancellation/deadlines cover upstream promises that may remain pending after disconnect.
  function bounded<T>(a: Attempt, promise: Promise<T>, ms: number, timeout: ErrorCode): Promise<T> {
    return new Promise((resolve,reject) => {
      const cancelled = () => { clearTimeout(timer); reject(new PlayerError(error ?? 'CANCELLED')); };
      const timer = setTimeout(() => { a.abort.signal.removeEventListener('abort',cancelled); reject(new PlayerError(timeout)); },ms);
      if (a.abort.signal.aborted) cancelled(); else a.abort.signal.addEventListener('abort',cancelled,{once:true});
      promise.then(resolve,reject).finally(() => {clearTimeout(timer); a.abort.signal.removeEventListener('abort',cancelled);});
    });
  }
  async function run(a: Attempt) {
    try {
      validate(config); ensure(a);
      a.socket = new ChannelSocket(code => fail(a,code));
      a.player = (deps.createPlayer ?? (o => new SendspinPlayer(o)))({
        webSocket:a.socket.asWebSocket(), storage:deps.storage, clientName:config.name??'Laptop', productName:'Web Player',
        codecs:['opus','flac'], requiredLeadTimeMs:250, minBufferMs:500,
        onPairing: event => { if (event === 'aborted') fail(a,'PAIRING_ABORTED'); },
      });
      playerId = a.player.clientId;
      phase = 'unlocking';
      // Must be the first awaited work: the click's transient user activation is still present.
      await bounded(a,a.player.unlock(),10000,'CONNECT_TIMEOUT'); ensure(a);
      a.transport = (deps.createTransport ?? (o => new WebRTCTransport(o)))({
        remoteId:config.remoteId, signalingServerUrl:config.signalingUrl,
        dataChannelLabel:'ma-api', skipCertificateVerification:false, reconnect:false, iceTransportPolicy:config.forceRelay?'relay':'all',
      });
      a.rpc = new RpcClient(a.transport);
      a.transport.on('close', () => fail(a,'API_CLOSED'));
      a.transport.on('error', () => fail(a,'API_ERROR'));
      phase = 'remote-connecting'; await bounded(a,a.transport.connect(),65000,'CONNECT_TIMEOUT'); ensure(a);
      phase = 'authenticating';
      const auth = record(await a.rpc.request('auth',{token:config.token})); ensure(a);
      if (auth.authenticated !== true) throw new PlayerError('AUTH_FAILED');
      authenticated = true;
      phase = 'opening-sendspin';
      const channel = await bounded(a,a.transport.openDataChannel('sendspin'),12000,'CONNECT_TIMEOUT'); ensure(a);
      if (!channel) throw new PlayerError('CHANNEL_INVALID');
      a.socket.attach(channel); ensure(a);
      phase = 'sdk-connecting'; await bounded(a,a.player.connect(),10000,'CONNECT_TIMEOUT'); ensure(a);
      if (!a.player.pairingToken) throw new PlayerError('PAIRING_UNAVAILABLE');
      // connect() only starts SDK client/init + Noise; MA waits for the connected encrypted client.
      phase = 'pairing'; await a.rpc.request('sendspin/pair_web_player',{pairing_token:a.player.pairingToken},45000); ensure(a);
      paired = true; phase = 'waiting-player';
      const timeout = deps.readinessTimeoutMs ?? 20000;
      const deadline = Date.now()+timeout;
      while (Date.now() < deadline) {
        try {
          const p = record(await a.rpc.request('players/get',{player_id:playerId}, Math.max(1,deadline-Date.now()))); ensure(a);
          if (p.player_id === playerId && p.available === true && a.player.isConnected) {available = true; phase = 'ready'; return status();}
        } catch (e) { ensure(a); if (!(e instanceof PlayerError) || !['RPC_REMOTE','RPC_TIMEOUT'].includes(e.code)) throw e; }
        await bounded(a,new Promise<void>(r=>setTimeout(r,deps.pollMs ?? 250)),1000,'PLAYER_NOT_READY'); ensure(a);
      }
      throw new PlayerError('PLAYER_NOT_READY');
    } catch (e) {
      const failure = safeError(e); fail(a,failure.code); throw new PlayerError(error ?? failure.code, failure.remoteCode);
    }
  }
  function connect() {
    if (phase === 'ready') return Promise.resolve(status());
    if (inFlight) return inFlight;
    if (active) cleanup(active);
    authenticated = paired = available = false; error = null;
    active = {abort:new AbortController()}; const a = active;
    const work = run(a); inFlight = work;
    void work.finally(() => { if (inFlight === work) inFlight = undefined; }).catch(()=>{});
    return work;
  }
  function disconnect() {
    if (active) cleanup(active);
    phase = 'disconnected'; error = null; authenticated = paired = available = false;
  }
  async function rpc(command: string, args: Record<string, unknown> = {}) {
    if (phase !== 'ready' || !active?.rpc) throw new PlayerError('NOT_READY');
    if (command === 'auth' || command.startsWith('auth/') || command === 'sendspin/pair_web_player') throw new PlayerError('RPC_RESERVED');
    validateRequest({command,args});return active.rpc.request(command,args);
  }
  async function health(){
    const a=active;if(!a||phase!=='ready')return;
    const started=performance.now();let stage:HealthStage='players-get';
    let checks: {idMatches:boolean;available:boolean;sdkConnected:boolean}|undefined;
    try{const p=record(await a.rpc!.request('players/get',{player_id:playerId},10000));ensure(a);
      stage='player-check';checks={idMatches:p.player_id===playerId,available:p.available===true,sdkConnected:!!a.player?.isConnected};
      if(!checks.idMatches||!checks.available||!checks.sdkConnected)throw new PlayerError('HEALTH_FAILED');
      stage='transport-stats';
      if(a.transport?.connectionStats)transportStats=await bounded(a,a.transport.connectionStats(),3000,'HEALTH_FAILED');
    }catch(e){
      const failure=safeError(e);
      if(active===a)lastHealthFailure=sanitizeHealthFailure({stage,elapsedMs:performance.now()-started,code:failure.code,remoteCode:failure.remoteCode,...checks});
      fail(a,'HEALTH_FAILED');throw failure;
    }
  }
  return {connect,status,rpc,disconnect,health,get playerId(){return playerId;}};
}
