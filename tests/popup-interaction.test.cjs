const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../BarWidget.qml'),'utf8');
test('stopping the title marquee resets its offset without disturbing a running animation',()=>{
  const handler=source.match(/id: scrollAnim\s+onRunningChanged: ([^\n]+)/);
  assert.ok(handler);
  for(const running of [false,true]) {
    const labelText={x:129.375};
    vm.runInNewContext(handler[1],{running,labelText});
    assert.equal(labelText.x,running ? 129.375 : 0);
  }
});
function method(name){const begin=source.indexOf('function '+name+'(');assert.ok(begin>=0,'missing '+name);const open=source.indexOf('{',begin);let depth=1,end=open+1;for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;if(source[end]==='}')depth--;}return source.slice(begin,end);}
function rig(section='now',open=true,connected=true){let calls=[],later=[];let root={popupSection:section,popupOpen:open,serviceConnected:connected,service:{refreshFavorites:()=>calls.push('favorites'),refreshPlaylists:()=>calls.push('playlists'),refreshRecent:()=>calls.push('recent')}};let box={root,Qt:{callLater:f=>later.push(f)},popupFocus:{forceActiveFocus:()=>calls.push('scope')},searchInput:{forceActiveFocus:()=>calls.push('input')}};vm.createContext(box);vm.runInContext(method('activatePopupSection'),box);return {root,calls,run:()=>box.activatePopupSection(),flush:()=>later.splice(0).forEach(f=>f())};}
test('popup uses the shell keyboard panel with an explicit focus target',()=>{assert.match(source,/KeyboardPanel\s*\{/);assert.match(source,/focusTarget:.*searchInput.*popupFocus/);assert.doesNotMatch(source,/grabFocus:/);});
test('changing tabs and reconnecting trigger section activation',()=>{assert.match(source,/onPopupSectionChanged:\s*\{[^}]*activatePopupSection\(\)/);assert.match(source,/onServiceConnectedChanged:[^\n]*activatePopupSection\(\)/);});
for(const section of ['favorites','playlists','recent'])test('entering '+section+' fetches its data without reopening popup',()=>{let r=rig(section);r.run();assert.deepEqual(r.calls,[section]);});
test('search focus follows the scope, never gets replaced by scope afterwards',()=>{let r=rig('search');r.run();r.flush();assert.deepEqual(r.calls,['scope','input']);});
test('closed or disconnected popup does not issue library RPCs',()=>{for(const [open,connected]of [[false,true],[true,false]]){let r=rig('favorites',open,connected);r.run();r.flush();assert.ok(!r.calls.includes('favorites'));}});
test('deferred focus honors closing or switching away from search',()=>{let r=rig('search');r.run();r.root.popupOpen=false;r.flush();assert.deepEqual(r.calls,[]);r=rig('search');r.run();r.root.popupSection='now';r.flush();assert.deepEqual(r.calls,['scope']);});
test('Now includes the existing queue below its player controls in the same scroll view',()=>{
  const queue=source.slice(source.indexOf('// ------------------ Queue section'),source.indexOf('// ------------------ Search section'));
  assert.match(queue,/visible: root\.popupSection === "now"/);
  assert.ok(source.indexOf('PlayerControls {')<source.indexOf('// ------------------ Queue section'));
  assert.equal((source.match(/ScrollView\s*\{/g)||[]).length,1);
  for(const action of ['clearQueue','deleteQueueItem','playIndex']) assert.ok(queue.includes('root.service.'+action+'('));
});
test('Now uses a music-note icon rather than the Facebook glyph',()=>{
  assert.match(source,/\{ id: "now", icon: "󰝚", label: "Now" \}/);
});
test('sidebar and keyboard navigation omit the separate Queue section',()=>{
  assert.doesNotMatch(source,/\{ id: "queue",/);
  for(const name of ['tabs','tabs2']) {
    const match=source.match(new RegExp('var '+name+' = (\\[[^\\n]+\\])'));
    assert.ok(match);assert.deepEqual(JSON.parse(match[1]),['now','players','search','favorites','playlists','recent']);
  }
});
