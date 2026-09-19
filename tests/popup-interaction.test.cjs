const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../BarWidget.qml'), 'utf8');

test('stopping the title marquee resets its offset', () => {
  const handler = source.match(/id: scrollAnim\s+onRunningChanged: ([^\n]+)/);
  const labelText = {x: 129.375};
  vm.runInNewContext(handler[1], {running: false, labelText});
  assert.equal(labelText.x, 0);
});

test('Now keeps the queue in the same scroll view and drops the Queue tab', () => {
  assert.equal((source.match(/ScrollView\s*\{/g) || []).length, 1);
  const queue = source.slice(source.indexOf('// ------------------ Queue section'), source.indexOf('// ------------------ Search section'));
  assert.match(queue, /visible: root\.popupSection === "now"/);
  assert.doesNotMatch(source, /\{ id: "queue",/);
  assert.match(source, /KeyboardPanel\s*\{/);
});
