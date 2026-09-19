import {constants} from 'node:fs';
import {open,mkdir,lstat,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {base32nopad} from '@scure/base';
export interface PlayerConfig {token:string;remoteId:string;signalingUrl:string;name:string;forceRelay:boolean}
export function configPath(home:string,configHome?:string){return join(configHome||join(home,'.config'),'music-assistant/config.json');}
export async function privateDirectory(path:string){
 await mkdir(path,{recursive:true,mode:0o700});const s=await lstat(path);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.())throw Error('CONFIG_PRIVATE');await chmod(path,0o700);
}
export async function loadConfig(path:string):Promise<PlayerConfig>{
 let handle;try{
 handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const s=await handle.stat();
 if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)||s.size>65536)throw Error('CONFIG_PRIVATE');
 const c=JSON.parse(await handle.readFile('utf8'));const p=c.localPlayer;
 if(!p||p.enabled!==true)throw Error('CONFIG_DISABLED');
 if(typeof c.token!=='string'||!c.token||c.token.length>16384||! /^[A-Z3-79]{26}$/.test(p.remoteId))throw Error('CONFIG_INVALID');
 const decoded=base32nopad.decode(p.remoteId.replace(/9/g,'2'));
 if(decoded.length!==16||base32nopad.encode(decoded).replace(/2/g,'9')!==p.remoteId)throw Error('CONFIG_INVALID');
 const url=new URL(p.signalingUrl);if(url.protocol!=='wss:'||url.username||url.password||url.search||url.hash)throw Error('CONFIG_INVALID');
 if(p.forceRelay!==undefined&&typeof p.forceRelay!=='boolean')throw Error('CONFIG_INVALID');
 if(p.name!==undefined&&(typeof p.name!=='string'||!p.name.trim()||p.name.length>80||/[\x00-\x1f]/.test(p.name)))throw Error('CONFIG_INVALID');
 return {token:c.token,remoteId:p.remoteId,signalingUrl:p.signalingUrl,name:p.name??'Laptop',forceRelay:p.forceRelay??false};
 }catch(e){if(e instanceof Error&&['CONFIG_PRIVATE','CONFIG_DISABLED'].includes(e.message))throw e;throw Error('CONFIG_INVALID');}finally{await handle?.close();}
}
export function bootstrap(value:{secret:string;port:number},bundle:string){
 const json=JSON.stringify(value).replace(/</g,'\\u003c');
 return `<!doctype html><meta charset="utf-8"><title>Local player</title><script>window.MA_BOOTSTRAP=${json};</script><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`;
}
export function chromiumArgs(state:string){return ['--headless=new','--autoplay-policy=no-user-gesture-required','--no-first-run','--no-default-browser-check','--disable-background-timer-throttling','--disable-renderer-backgrounding',`--user-data-dir=${join(state,'profile')}`,pathToFileURL(join(state,'bootstrap.html')).href];}
