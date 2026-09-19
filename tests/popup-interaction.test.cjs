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

test('elapsed and duration sit on opposite ends of the progress row', () => {
  const controls = fs.readFileSync(require('node:path').join(__dirname, '../PlayerControls.qml'), 'utf8');
  assert.match(controls, /formatTime\(progressSlider\.dragging \? progressSlider\.liveValue : localElapsed\)/);
  assert.match(controls, /text: formatTime\(root\.duration\)/);
  assert.match(controls, /anchors\.left: parent\.left/);
  assert.match(controls, /anchors\.right: parent\.right/);
  assert.doesNotMatch(controls, /Item \{ width: 1; height: 1 \}/);
});

test('progress slider seeks on release with 5s wheel steps, not on every drag tick', () => {
  const controls = fs.readFileSync(require('node:path').join(__dirname, '../PlayerControls.qml'), 'utf8');
  assert.match(controls, /step: 5000/);
  assert.match(controls, /onReleased: /);
  assert.doesNotMatch(controls, /onMoved: root\.seek/);
});

test('favorite icon is an outline heart until the current track is favorited', () => {
  const controls = fs.readFileSync(require('node:path').join(__dirname, '../PlayerControls.qml'), 'utf8');
  assert.match(controls, /iconText: root\.isFavorite \? "󰋑" : "󰋕"/);
  assert.doesNotMatch(controls, /󰥂/);
});

test('Now keeps the queue in the same scroll view and drops the Queue tab', () => {
  assert.equal((source.match(/ScrollView\s*\{/g) || []).length, 1);
  const queue = source.slice(source.indexOf('// ------------------ Queue section'), source.indexOf('// ------------------ Search section'));
  assert.match(queue, /visible: root\.popupSection === "now"/);
  assert.doesNotMatch(source, /\{ id: "queue",/);
  assert.match(source, /KeyboardPanel\s*\{/);
  assert.match(source, /text: "Play on this device"/);
  assert.match(source, /onClicked: root\.service\.playOnThisDevice\(\)/);
  assert.match(source, /isFavorite: root\.service \? root\.service\.isFavorite : false/);
  assert.match(queue, /HoverMarquee/);
  assert.match(queue, /hoverEnabled: true/);
});

test('overflowing list titles circular-scroll on hover and reset when the hover ends', () => {
  const row = fs.readFileSync(require('node:path').join(__dirname, '../SearchResultRow.qml'), 'utf8');
  const marquee = fs.readFileSync(require('node:path').join(__dirname, '../HoverMarquee.qml'), 'utf8');
  assert.match(row, /HoverMarquee/);
  assert.match(row, /hoverEnabled: true/);
  assert.match(marquee, /clip: true/);
  assert.match(marquee, /id: copy/);
  assert.match(marquee, /SequentialAnimation/);
  assert.match(marquee, /PauseAnimation/);
  assert.match(marquee, /running: root\.hovered && /);
  const handler = marquee.match(/onRunningChanged: ([^\n]+)/);
  const ticker = {x: -40};
  vm.runInNewContext(handler[1], {running: false, ticker});
  assert.equal(ticker.x, 0);
});
