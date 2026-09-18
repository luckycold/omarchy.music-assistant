import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';

test('browser artifact exposes automation, consumes private config, contains no console calls', () => {
  assert.ok(existsSync('build.mjs'), 'build entry must exist');
  execFileSync(process.execPath,['build.mjs']);
  const code = readFileSync('dist/spike.js','utf8');
  assert.ok(!/console\.(log|warn|error|debug|info)\(/.test(code));
  const els = new Map<string,any>();
  const element = (id:string) => {if(!els.has(id)) els.set(id,{textContent:'',disabled:false,addEventListener:()=>{}});return els.get(id);};
  const window: any = {MA_SPIKE_CONFIG:{token:'sensitive-test-token',remoteId:'AAAAAAAAAAAAAAAAAAAAAAAAAA',signalingUrl:'wss://example.org/ws'},addEventListener:()=>{}};
  const context = vm.createContext({window,document:{getElementById:element},navigator:{userAgent:'Chromium'},
    btoa,atob,TextEncoder,TextDecoder,URL,AbortController,setInterval:()=>0,clearInterval:()=>{}, setTimeout,clearTimeout, Event, performance, console});
  vm.runInContext(code,context);
  assert.equal(typeof window.maSpike.connect,'function'); assert.equal(typeof window.maSpike.rpc,'function');
  assert.equal(typeof window.maSpike.disconnect,'function'); assert.equal(window.maSpike.playerId,null);
  assert.equal(window.MA_SPIKE_CONFIG,undefined);
  assert.equal(window.maSpike.status().phase,'idle'); assert.ok(!els.get('status').textContent.includes('sensitive-test-token'));
});
