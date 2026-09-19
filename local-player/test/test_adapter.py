import asyncio
import sys
import unittest
from pathlib import Path
from aiohttp import WSMsgType
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_adapter import DataChannelSocket

class Channel:
    def __init__(self):
        self.readyState = 'open'
        self.bufferedAmount = 0
        self.callbacks = {}
        self.sent = []
    def on(self, name, callback=None):
        def register(cb): self.callbacks[name] = cb; return cb
        return register(callback) if callback else register
    def send(self, value): self.sent.append(value)
    def close(self): self.readyState = 'closed'; self.callbacks['close']()

class AdapterTest(unittest.IsolatedAsyncioTestCase):
    async def test_text_binary_preserved(self):
        c = Channel(); ws = DataChannelSocket(c)
        c.callbacks['message']('hello'); c.callbacks['message'](b'\x00\xff')
        a, b = await ws.receive(), await ws.receive()
        self.assertEqual((a.type, a.data), (WSMsgType.TEXT, 'hello'))
        self.assertEqual((b.type, b.data), (WSMsgType.BINARY, b'\x00\xff'))
        await ws.send_str('reply'); await ws.send_bytes(b'123')
        self.assertEqual(c.sent, ['reply', b'123'])
    async def test_input_queue_bounded(self):
        c = Channel(); ws = DataChannelSocket(c, max_messages=1)
        c.callbacks['message']('first'); c.callbacks['message']('overflow')
        self.assertTrue(ws.closed)
        self.assertIsInstance(ws.exception(), BufferError)

if __name__ == '__main__': unittest.main()
