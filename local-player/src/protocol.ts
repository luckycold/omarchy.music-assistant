export const MAX_REQUEST=64*1024, MAX_RESPONSE=8*1024*1024, MAX_PENDING=32;
export const ERRORS=['RPC_REMOTE','RPC_SEND','RPC_TIMEOUT','RPC_CLOSED','RPC_PROTOCOL','RPC_LIMIT','CHANNEL_CLOSED','CHANNEL_INVALID','CHANNEL_ERROR','SDK_EVENT','SENDSPIN_CLOSED','CONFIG_INVALID','CONFIG_PRIVATE','CONFIG_DISABLED','AUTH_FAILED','CONNECT_FAILED','CONNECT_TIMEOUT','CANCELLED','PAIRING_ABORTED','PAIRING_UNAVAILABLE','PLAYER_NOT_READY','API_CLOSED','API_ERROR','NOT_READY','RPC_RESERVED','BAD_REQUEST','BRIDGE_CLOSED','BRIDGE_TIMEOUT','BRIDGE_AUTH','HEALTH_FAILED','BROWSER_EXIT','INTERNAL'] as const;
export function safeCode(value:unknown){return typeof value==='string'&&(ERRORS as readonly string[]).includes(value)?value:'INTERNAL';}
export function validateRequest(value:any):{command:string,args:Record<string,unknown>} {
 if(!value||typeof value!=='object'||typeof value.command!=='string'||! /^[a-z][a-z0-9_]*(?:\/[a-z][a-z0-9_]*)*$/.test(value.command)||value.command.length>160||!value.args||typeof value.args!=='object'||Array.isArray(value.args))throw Error('BAD_REQUEST');
 if(value.command==='auth'||value.command.startsWith('auth/')||value.command==='sendspin/pair_web_player')throw Error('RPC_RESERVED');
 if(JSON.stringify(value).length>MAX_REQUEST)throw Error('RPC_LIMIT');
 return {command:value.command,args:value.args};
}
export type HealthStage = 'players-get'|'player-check'|'transport-stats';
export function sanitizeHealthFailure(value:any) {
 if(!value||!['players-get','player-check','transport-stats'].includes(value.stage))return null;
 return {stage:value.stage as HealthStage,
 elapsedMs:typeof value.elapsedMs==='number'&&Number.isFinite(value.elapsedMs)?Math.min(2147483647,Math.max(0,Math.floor(value.elapsedMs))):0,
 code:safeCode(value.code),
 ...(typeof value.remoteCode==='number'&&Number.isInteger(value.remoteCode)?{remoteCode:value.remoteCode}:{}),
 ...(value.stage==='player-check'?{idMatches:value.idMatches===true,available:value.available===true,sdkConnected:value.sdkConnected===true}:{})};
}
export function sanitizeStatus(s:any={}) {
 const phases=['idle','unlocking','remote-connecting','authenticating','opening-sendspin','sdk-connecting','pairing','waiting-player','ready','failed','disconnected','starting','reconnecting','stopped'];
 const phase=phases.includes(s.phase)?s.phase:'starting';
 const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:0;
 return {phase,ready:phase==='ready'&&s.ready===true,playerId:typeof s.playerId==='string'&&/^[A-Za-z0-9_-]{43}$/.test(s.playerId)?s.playerId:null,playing:s.playing===true,error:s.error? safeCode(s.error):null,
 authenticated:s.authenticated===true,paired:s.paired===true,playerAvailable:s.playerAvailable===true,apiConnected:s.apiConnected===true,sendspinConnected:s.sendspinConnected===true,timeSynced:s.timeSynced===true,codec:['opus','pcm','flac'].includes(s.codec)?s.codec:null,
 transport:{localCandidateType:['host','srflx','prflx','relay'].includes(s.transport?.localCandidateType)?s.transport.localCandidateType:null,receivedBytes:count(s.transport?.receivedBytes)},
 channel:{rxBinary:count(s.channel?.rxBinary),rxBytes:count(s.channel?.rxBytes)},lastHealthFailure:sanitizeHealthFailure(s.lastHealthFailure)};
}
