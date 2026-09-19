const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../Service.qml'), 'utf8');
const MaApi = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../MaApi.js'), 'utf8').replace('.pragma library', ''), MaApi);
function method(name, root, extra = {}) {
  const m = source.match(new RegExp('  function ' + name + '\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}'));
  assert.ok(m, `missing ${name}`);
  return vm.runInNewContext(`(function(${m[1]}) {${m[2]}\n})`, {root, MaApi, ...extra});
}
function reply(id, root) {
  const m = source.match(new RegExp('id: ' + id + '\\n    handleReply: function\\(value, context\\) \\{([\\s\\S]*?)\\n    \\}'));
  assert.ok(m, `missing reply ${id}`);
  return vm.runInNewContext(`(function(value, context) {${m[1]}\n})`, {root, MaApi});
}
function harness() {
  const calls = [];
  const root = {ready:true, connected:true, activePlayerId:'speaker', activeQueueId:'group', activeQueuePlayerId:'speaker', queueEpoch:0,
    queue:[{uri:'library://track/1'}], queuePosition:7, shuffleEnabled:true, repeatMode:'all',
    playerById:()=>({available:true}), config:{}, persistConfig(){}, refreshState(){}, refreshFavorites(){},
    runAction:(command,args)=>{calls.push({command,args}); return true;},
    buildRequest:(command,args)=>({command,args}), runMaRequest:(proc,payload)=>{calls.push(payload); return true;}};
  for (const name of ['actionForPlayer','seek','seekRelative','applyQueue','toggleShuffle','cycleRepeat']) root[name] = method(name,root);
  return {root,calls};
}
test('unresolved local identity fails closed for MPRIS',()=>{
  const root={localPlayerEnabled:true,localPlayerId:'',localPlayerSelected:false,config:{}};
  const route=method('mprisRoutingEnabled',root); assert.equal(route(),false);
  root.localPlayerId='local'; assert.equal(route(),true);
  root.localPlayerSelected=true; assert.equal(route(),false);
});
test('pending config save preserves latest snapshot across stale watcher reload',()=>{
  const saver={running:true,savePending:false};
  const root={ready:true,config:{preferredPlayerId:'B'},configPath:'/config.json',pendingConfigJson:'',
    flushConfigSave(){},configSaveScript:()=>''};
  method('persistConfig',root,{configSaver:saver})();
  assert.equal(JSON.parse(root.pendingConfigJson).preferredPlayerId,'B');
  method('applyConfig',root,{configSaver:saver,ConfigSchema:{parse:()=>assert.fail('stale own write applied')}})('{"preferredPlayerId":"A"}');
  assert.equal(root.config.preferredPlayerId,'B');
  root.config={preferredPlayerId:'A'}; saver.running=false;
  method('flushConfigSave',root,{configSaver:saver,Quickshell:{env:()=>''}})();
  assert.equal(JSON.parse(saver.saveJson).preferredPlayerId,'B');
});
test('seek keeps UI milliseconds but sends seconds in position',()=>{
  const {root,calls}=harness(); root.seek('',12500);
  assert.equal(JSON.stringify(calls[0]),JSON.stringify({command:'player_queues/seek',args:{position:12.5,queue_id:'group'}}));
  root.activeElapsed=20000; root.activeMedia={elapsed_time:20}; root.seekRelative(5000);
  assert.equal(calls[1].args.position,25);
});
test('server time seconds become UI milliseconds',()=>{
  for (const [name,key] of [['activeElapsed','elapsed_time'],['activeDuration','duration']]) {
    const expr=source.match(new RegExp('readonly property int '+name+': (.+)'))[1];
    assert.equal(vm.runInNewContext(expr,{activeMedia:{[key]:12.5}}),12500);
  }
});
test('poll resolves active queue before fetching bare item list',()=>{
  const {root,calls}=harness();
  method('runFetchQueue',root,{activeQueueProc:{},queueProc:{}})('speaker');
  assert.equal(calls[0].command,'player_queues/get_active_queue');
  assert.equal(calls[0].args.player_id,'speaker');
  root.runFetchQueueItems=method('runFetchQueueItems',root,{queueProc:{}});
  root.applyActiveQueue=method('applyActiveQueue',root);
  reply('activeQueueProc',root)({queue_id:'leader',current_index:3,shuffle_enabled:true,repeat_mode:'one'},calls[0].context);
  assert.equal(root.activeQueueId,'leader'); assert.equal(root.queuePosition,3);
  assert.equal(calls[1].args.queue_id,'leader'); assert.equal(calls[1].command,'player_queues/items');
  root.applyQueue([]); assert.equal(root.queuePosition,3);
  root.applyActiveQueue({queue_id:'leader',current_index:null},'speaker'); assert.equal(root.queuePosition,-1);
});
test('queue controls use queue state, not absent player fields',()=>{
  const {root,calls}=harness(); root.toggleShuffle(); root.cycleRepeat();
  assert.equal(calls[0].args.shuffle_enabled,false); assert.equal(calls[1].args.repeat_mode,'one');
  root.actionForPlayer('', 'players/cmd/volume_set', {volume_level:40});
  assert.equal(calls[2].args.player_id,'speaker'); assert.equal(calls[2].args.queue_id,undefined);
});
test('switch invalidates queue synchronously and stale replies cannot retarget',()=>{
  const {root,calls}=harness(); root.resetQueueContext=method('resetQueueContext',root);
  root.setActivePlayer=method('setActivePlayer',root);
  method('activatePlayer',root)('other');
  assert.equal(root.activeQueueId,''); assert.equal(root.queuePosition,-1);
  root.actionForPlayer('', 'player_queues/pause'); assert.equal(calls.length,0);
  root.applyActiveQueue=method('applyActiveQueue',root); root.runFetchQueueItems=()=>assert.fail('stale queue fetch');
  reply('activeQueueProc',root)({queue_id:'old'}, {playerId:'speaker',queueEpoch:0});
  assert.equal(root.activeQueueId,'');
});
test('favorite and playlist listings use MA library endpoints',()=>{
  const {root,calls}=harness(); root._favTypes=['tracks','albums','artists','playlists','radio']; root._favIndex=0;
  const next=method('_favFetchNext',root,{favProc:{}}); for(let i=0;i<5;i++) next();
  assert.deepEqual(calls.map(c=>c.command),['tracks','albums','artists','playlists','radios'].map(t=>'music/'+t+'/library_items'));
  for(const c of calls) assert.equal(JSON.stringify(c.args),JSON.stringify({favorite:true,limit:50,offset:0}));
  method('refreshPlaylists',root,{playlistsProc:{}})(); assert.equal(calls[5].command,'music/playlists/library_items');
});
test('remove favorite accepts only library singular media URIs',()=>{
  const {root,calls}=harness(); root.actionForSourceTarget=root.runAction;
  const remove=method('removeFavorite',root); remove('library://track/42');
  assert.equal(JSON.stringify(calls[0].args),JSON.stringify({media_type:'track',library_item_id:'42'}));
  for(const uri of ['spotify://track/42','library://tracks/42','library://track/42/more','library://track/not-an-id']) remove(uri);
  assert.equal(calls.length,1); assert.equal(root.lastError,'FAVORITE_REQUIRES_LIBRARY_ITEM');
  method('addFavorite',root)('spotify://track/42'); assert.equal(calls[1].args.item,'spotify://track/42');
});
test('save queue uses server snapshot without treating scheduling as completion',()=>{
  const {root,calls}=harness(), saveQueueProc={busy:false};
  root.showOsd=()=>assert.fail('not saved yet'); root.refreshPlaylists=()=>assert.fail('task not complete');
  const save=method('saveQueueAsPlaylist',root,{saveQueueProc});
  save('Road');
  assert.equal(calls[0].command,'player_queues/save_as_playlist');
  assert.equal(JSON.stringify(calls[0].args),JSON.stringify({queue_id:'group',name:'Road'}));
  const proc=source.match(/MaRequest\s*\{\s*id: saveQueueProc\b([\s\S]*?)\n  \}/);
  assert.ok(proc); assert.doesNotMatch(proc[1], /showOsd|refreshPlaylists/);
  saveQueueProc.busy=true; save('Busy');
  saveQueueProc.busy=false; save('');
  root.activeQueuePlayerId='other'; save('Wrong player');
  root.activeQueuePlayerId='speaker'; root.activeQueueId=''; save('Unresolved');
  root.activeQueueId='group'; root.queue=[]; save('Empty');
  assert.equal(calls.length,1);
});
test('actions retain connection gating and refresh on completion',()=>{
  const {root,calls}=harness(), actionProc={};
  const run=method('runAction',root,{actionProc});
  root.connected=false; assert.equal(run('player_queues/pause',{}),false);
  root.connected=true; root.ready=false; assert.equal(run('player_queues/pause',{}),false);
  assert.equal(calls.length,0);
  root.ready=true; assert.equal(run('player_queues/pause',{queue_id:'group'}),true);
  assert.equal(JSON.stringify(calls[0]),JSON.stringify({command:'player_queues/pause',args:{queue_id:'group'}}));
  const handler=source.match(/id: actionProc\s+onCompleted: ([^\n]+)/);
  assert.ok(handler); let refreshes=0;
  vm.runInNewContext(handler[1],{refreshTimer:{restart(){refreshes++;}}});
  assert.equal(refreshes,1);
});
