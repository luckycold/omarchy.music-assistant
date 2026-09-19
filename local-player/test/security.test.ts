import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,writeFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {loadConfig,privateDirectory,bootstrap,chromiumArgs} from '../src/config.ts';
import {validateRequest,sanitizeStatus} from '../src/protocol.ts';
const cfg={token:'secret-token',url:'https://example.org',localPlayer:{enabled:true,remoteId:'AAAAAAAAAAAAAAAAAAAAAAAAAA',signalingUrl:'wss://signaling.music-assistant.io/ws'}};
test('private config, defaults, strict identity and relay validation',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'test/tmp-')); try {
 const file=join(dir,'config.json'); await writeFile(file,JSON.stringify(cfg),{mode:0o600});
 const c=await loadConfig(file); assert.equal(c.name,'Laptop'); assert.equal(c.forceRelay,false);
 await chmod(file,0o644); await assert.rejects(loadConfig(file),/CONFIG_PRIVATE/);
 await chmod(file,0o600); for(const bad of [{remoteId:'bad'}, {forceRelay:'yes'}, {signalingUrl:'ws://evil'}, {enabled:false}]){
 await writeFile(file,JSON.stringify({...cfg,localPlayer:{...cfg.localPlayer,...bad}}));await assert.rejects(loadConfig(file),/CONFIG_/);}
 await privateDirectory(join(dir,'state'));assert.equal((await stat(join(dir,'state'))).mode&0o777,0o700);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('protocol reserves authentication and rejects malformed commands',()=>{
 for(const command of ['auth','auth/login','sendspin/pair_web_player','../auth','', ' auth']) assert.throws(()=>validateRequest({command,args:{}}));
 assert.deepEqual(validateRequest({command:'players/get',args:{player_id:'abc'}}),{command:'players/get',args:{player_id:'abc'}});
 assert.throws(()=>validateRequest({command:'players/get',args:[]}));
 const s=sanitizeStatus({phase:'ready',ready:true,playerId:'a'.repeat(43),playing:true,token:'secret',error:'secret',transport:{localCandidateType:'relay',receivedBytes:9,ip:'secret'}});
 assert.ok(!JSON.stringify(s).includes('secret'));assert.equal(s.transport.localCandidateType,'relay');
});
test('bootstrap escapes script injection; Chromium args contain no secrets/bypass/CDP/mute',()=>{
 const html=bootstrap({secret:'</script><script>oops',port:1234},'BUNDLE');assert.ok(!html.includes('</script><script>oops'));
 const args=chromiumArgs('/state');const text=args.join(' '); for(const banned of ['--no-sandbox','ignore-certificate','remote-debugging','--mute-audio'])assert.ok(!text.includes(banned));
 assert.ok(text.includes('--autoplay-policy=no-user-gesture-required'));assert.ok(text.includes('--headless'));
});
