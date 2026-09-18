const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../Service.qml'), 'utf8');

test('runtime config is outside the watched plugin source tree', () => {
  const expression = source.match(/readonly property string configPath: (.+)/)[1];
  for (const configHome of ['', '/custom/config']) {
    const actual = vm.runInNewContext(expression, {
      home: '/home/test', pluginId: 'io.github.manologarciadev.music-assistant',
      Quickshell: {env: name => name === 'XDG_CONFIG_HOME' ? configHome : ''},
    });
    assert.equal(actual, `${configHome || '/home/test/.config'}/music-assistant/config.json`);
  }
});

test('file-change notification reloads data instead of applying stale cached text', () => {
  const handler = source.match(/onFileChanged: (.+)/)[1];
  let reloads = 0;
  vm.runInNewContext(handler, {
    reload: () => reloads++, text: () => 'stale cached config',
    root: {applyConfig: () => assert.fail('applied stale cached text')},
  });
  assert.equal(reloads, 1);
});
