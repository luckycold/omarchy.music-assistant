const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('local media support does not expose exclusive selected-player key handlers', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'Service.qml'), 'utf8');
  assert.doesNotMatch(source, /function mediaPlayPause\(/);
  assert.doesNotMatch(source, /function mediaPause\(/);
});
