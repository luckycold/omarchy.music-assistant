import {readFile,writeFile,unlink,open,constants} from 'node:fs/promises';
import {spawn,type ChildProcess} from 'node:child_process';
import {homedir} from 'node:os';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {loadConfig,privateDirectory,bootstrap,chromiumArgs} from './config';import {createBridge} from './bridge';
process.umask(0o077);
const state=join(homedir(),'.local/state/music-assistant-player');let child:ChildProcess|undefined;let bridge:Awaited<ReturnType<typeof createBridge>>|undefined;let stopping=false;
async function stop(code:number){if(stopping)return;stopping=true;
 if(child?.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}setTimeout(()=>{try{process.kill(-child!.pid!,'SIGKILL');}catch{}},1500).unref();}
 await bridge?.close();await unlink(join(state,'bootstrap.html')).catch(()=>{});setTimeout(()=>process.exit(code),1700);
}
process.on('SIGTERM',()=>void stop(0));process.on('SIGINT',()=>void stop(0));
process.on('uncaughtException',()=>void stop(1));process.on('unhandledRejection',()=>void stop(1));
try{
 const config=await loadConfig(join(homedir(),'.config/music-assistant/config.json'));
 await privateDirectory(state);await privateDirectory(join(state,'profile'));
 bridge=await createBridge({state,config,onUnhealthy:()=>void stop(1)});
 const bundle=await readFile(join(dirname(fileURLToPath(import.meta.url)),'browser.js'),'utf8');
 // Atomic replace, no following stale symlinks. Bootstrap contains only loopback secret.
 const temp=join(state,'bootstrap.tmp');const f=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
 await f.writeFile(bootstrap({secret:bridge.secret,port:bridge.port},bundle));await f.close();
 const {rename}=await import('node:fs/promises');await rename(temp,join(state,'bootstrap.html'));
 child=spawn(process.env.MA_PLAYER_CHROMIUM||'chromium',chromiumArgs(state),{stdio:'ignore',detached:true});
 child.once('error',()=>void stop(1));child.once('exit',()=>void stop(1));
}catch{process.stderr.write('PLAYER_START_FAILED\n');await stop(1);}
