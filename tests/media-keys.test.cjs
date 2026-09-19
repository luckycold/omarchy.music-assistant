const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
test('local media support does not expose exclusive selected-player key handlers', () => {
  const source = read('Service.qml')
  assert.doesNotMatch(source, /function mediaPlayPause\(/)
  assert.doesNotMatch(source, /function mediaPause\(/)
})
test('local-player example does not reserve normal global media keys', () => {
  const file = path.join(__dirname, '../examples/media-keys.lua')
  assert.ok(!fs.existsSync(file) || !/hl\.unbind/.test(fs.readFileSync(file, 'utf8')))
})
test('managed player brings up its own MPRIS companion', () => {
  assert.match(read('local-player/omarchy-ma-player.service'), /Wants=.*omarchy-ma-mpris\.service/)
})
test('installer checks D-Bus dependencies and installs the local media adapter', () => {
  const source = read('local-player/install.sh')
  assert.match(source, /import dbus/)
  assert.match(source, /import GLib/)
  assert.match(source, /install .*mpris\.py/)
  assert.match(source, /install .*omarchy-ma-mpris\.service/)
})
