import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync,existsSync,rmSync} from 'node:fs';import {execFileSync} from 'node:child_process';

test('build distributes the complete noble ciphers MIT license including Thomas Pornin attribution',()=>{
 const artifact='dist/licenses/@noble_ciphers-LICENSE';
 rmSync(artifact,{force:true});
 execFileSync(process.execPath,['build.mjs'],{stdio:'pipe'});
 assert.ok(existsSync(artifact),'build must distribute @noble/ciphers full license');
 const license=readFileSync(artifact,'utf8');
 assert.equal(license,readFileSync('node_modules/@noble/ciphers/LICENSE','utf8'));
 assert.match(license,/Thomas Pornin/);
 assert.match(license,/Permission is hereby granted/);
 assert.match(license,/THE SOFTWARE IS PROVIDED “AS IS”/);
});
test('production browser and supervisor have no exposed debug surface, service owns process group',()=>{const service=readFileSync('omarchy-ma-player.service','utf8');assert.match(service,/KillMode=control-group/);assert.match(service,/Restart=on-failure/);assert.match(service,/UMask=0077/);const browser=readFileSync('src/browser.ts','utf8');assert.ok(!browser.includes('window.maSpike'));assert.match(browser,/localStorage/);assert.match(readFileSync('src/daemon.ts','utf8'),/SIGTERM/);});
