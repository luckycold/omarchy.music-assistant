import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelSocket } from '../src/channel-socket.ts';
import { FakeChannel } from './helpers.ts';

test('adapts ordered sendspin channel with text and ArrayBuffer events and readyState', () => {
  const failures: string[] = []; const socket = new ChannelSocket(code => failures.push(code)); assert.equal(socket.readyState,0);
  const dc = new FakeChannel(); socket.attach(dc as unknown as RTCDataChannel);
  assert.equal(socket.readyState,1); assert.equal(dc.binaryType,'arraybuffer');
  const data = new Uint8Array([1,2]).buffer; const received: unknown[] = [];
  socket.onmessage = (event: MessageEvent) => received.push(event.data);
  dc.dispatchEvent(new MessageEvent('message',{data:'hello'})); dc.dispatchEvent(new MessageEvent('message',{data}));
  dc.dispatchEvent(new MessageEvent('message',{data:new Uint8Array([3])}));
  assert.deepEqual(failures,['CHANNEL_ERROR']);
  assert.deepEqual(received,['hello',data]); socket.send('out'); socket.send(data); assert.deepEqual(dc.sent,['out',data]);
  assert.deepEqual(socket.stats(),{rxBinary:1,rxBytes:2});
  socket.close(); assert.equal(socket.readyState,3); assert.throws(()=>socket.send('no'),/CHANNEL_CLOSED/);
});
test('rejects unordered/wrong-label channel and no attach after close', () => {
  for (const field of ['ordered','label']) { const dc = new FakeChannel(); (dc as any)[field] = field === 'ordered' ? false : 'ma-api';
    assert.throws(()=>new ChannelSocket().attach(dc as unknown as RTCDataChannel), /CHANNEL_INVALID/); }
  const socket = new ChannelSocket(); socket.close(); const dc = new FakeChannel();
  assert.throws(()=>socket.attach(dc as unknown as RTCDataChannel), /CHANNEL_CLOSED/); assert.equal(dc.readyState,'closed');
});
test('SDK thrown callbacks and channel errors are contained with static diagnostics', () => {
  const failures: string[] = []; const socket = new ChannelSocket((code: string) => failures.push(code));
  const dc = new FakeChannel(); socket.attach(dc as unknown as RTCDataChannel);
  socket.onmessage = () => { throw new Error('private identity'); };
  dc.dispatchEvent(new MessageEvent('message',{data:'secret'}));
  dc.dispatchEvent(new Event('error'));
  assert.deepEqual(failures,['SDK_EVENT','CHANNEL_ERROR']);
});
