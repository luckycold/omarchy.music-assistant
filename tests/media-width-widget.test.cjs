const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../BarWidget.qml'), 'utf8');
test('media viewport fills its allocation with a bounded stock fallback', () => {
  assert.match(source, /FlexibleMediaWidth \{/);
  assert.match(source, /setting\("fillAvailable", true\)/);
  assert.match(source, /Math.max\(0, flexWidth.allocatedWidth - root.minimumMediaWidth\)/);
  assert.match(source, /Math.min\(root.maxLabelWidth, labelText.implicitWidth\)/);
});
test('marquee stops at the origin when expanded text fits', () => {
  assert.match(source, /onRunningChanged: if \(!running\) labelText.x = 0/);
});
