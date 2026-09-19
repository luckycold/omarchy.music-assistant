import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32nopad } from '@scure/base';
import { SendspinCore, loadSendspinClientIdentity } from '@sendspin/sendspin-js';
import { verifyAndSanitizeSdp } from '../src/vendor/frontend/crypto-utils.ts';
import { ChannelSocket } from '../src/channel-socket.ts';
import { FakeChannel, memoryStorage } from './helpers.ts';

test('pinned certificate verification accepts matching fingerprint and rejects media-level mismatch', () => {
  const bytes = Uint8Array.from({length:32},(_,i)=>i);
  const remoteId = base32nopad.encode(bytes.slice(0,16)).replace(/2/g,'9');
  const fingerprint = Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(':');
  const sdp = `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\na=fingerprint:sha-512 aa:bb\r\n`;
  const cleaned = verifyAndSanitizeSdp(sdp,remoteId);
  assert.ok(!cleaned.includes('sha-512'));
  assert.throws(()=>verifyAndSanitizeSdp(sdp+`a=fingerprint:sha-256 ff:${fingerprint.slice(3)}\r\n`,remoteId),/Fingerprint mismatch/);
  assert.throws(()=>verifyAndSanitizeSdp('v=0',remoteId),/No SHA-256/);
});
test('real SDK 5 adopts adapter and sends client/init using persisted identity, never proxy auth', async () => {
  const storage = memoryStorage(); const identity = loadSendspinClientIdentity(storage);
  assert.equal(loadSendspinClientIdentity(storage).clientId,identity.clientId);
  assert.match(identity.clientId,/^[A-Za-z0-9_-]{43}$/);
  const channel = new FakeChannel(); const socket = new ChannelSocket(); socket.attach(channel as unknown as RTCDataChannel);
  const core = new SendspinCore({webSocket:socket.asWebSocket(),storage,productName:'Web Player',codecs:['pcm']});
  try {
    await core.connect();
    const init = JSON.parse(channel.sent[0] as string);
    assert.equal(init.type,'client/init'); assert.equal(init.payload.client_id,identity.clientId);
    assert.equal(init.payload.suite,'25519_ChaChaPoly_SHA256'); assert.match(core.pairingToken!,/^SP:0[A-Z3-79]+$/);
    assert.equal(channel.sent.length,1); // No plaintext hello/proxy auth before server/init + Noise.
  } finally { core.disconnect('user_request'); }
});
