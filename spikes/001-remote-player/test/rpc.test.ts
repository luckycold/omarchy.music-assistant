import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient } from '../src/rpc.ts';
import { FakeTransport } from './helpers.ts';

test('correlates concurrent replies out of order, ignoring server info/events/unknown ids', async () => {
  const transport = new FakeTransport(); const rpc = new RpcClient(transport, 100);
  const a = rpc.request('players/get', {player_id:'a'}); const b = rpc.request('players/get', {player_id:'b'});
  assert.notEqual(transport.sent[0].message_id, transport.sent[1].message_id);
  for (const msg of [{server_id:'s'}, {event:'player_added'}, {message_id:'wrong', result:3}]) transport.emit('message', JSON.stringify(msg));
  transport.reply(transport.sent[1], 'B'); transport.reply(transport.sent[0], 'A');
  assert.deepEqual(await Promise.all([a,b]), ['A','B']); rpc.dispose();
});
test('collects partial array replies until final reply', async () => {
  const t = new FakeTransport(); const rpc = new RpcClient(t,100); const p = rpc.request('items');
  t.emit('message', JSON.stringify({message_id:t.sent[0].message_id,result:[1],partial:true}));
  t.reply(t.sent[0], [2]); assert.deepEqual(await p,[1,2]); rpc.dispose();
});
test('does not leak auth args, server details, or raw errors in failures', async () => {
  const secret = 'TOKEN-AND-PAIRING-PRIVATE';
  const t = new FakeTransport(); const rpc = new RpcClient(t,100);
  const p = rpc.request('auth', {token:secret});
  t.emit('message', JSON.stringify({message_id:t.sent[0].message_id,error_code:11,details:secret}));
  await assert.rejects(p, (e: any) => e.code === 'RPC_REMOTE' && e.remoteCode === 11 && !JSON.stringify(e).includes(secret) && !e.stack.includes(secret));
  t.send = () => { throw new Error(secret); };
  await assert.rejects(rpc.request('auth',{token:secret}), /RPC_SEND/); rpc.dispose();
});
test('timeouts and closed connections reject and dispose removes handlers', async () => {
  const t = new FakeTransport(); const rpc = new RpcClient(t,5);
  await assert.rejects(rpc.request('slow'), /RPC_TIMEOUT/);
  const p = rpc.request('pending'); t.emit('close','private key'); await assert.rejects(p,/RPC_CLOSED/);
  rpc.dispose(); assert.equal([...t.handlers.values()].reduce((n,s)=>n+s.size,0),0);
  await assert.rejects(rpc.request('after'), /RPC_CLOSED/);
});
test('malformed matching results fail safely and malformed JSON does not log payload', async () => {
  const t = new FakeTransport(); const rpc = new RpcClient(t,100); const p = rpc.request('auth');
  t.emit('message','not JSON secret');
  t.emit('message', JSON.stringify({message_id:t.sent[0].message_id,details:'secret'}));
  await assert.rejects(p,/RPC_PROTOCOL/); rpc.dispose();
});
