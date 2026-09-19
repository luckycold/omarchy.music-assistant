"""In-process SCTP adapter for aiosendspin's aiohttp socket interface.
No listener, port, proxy process or JavaScript. Experimental, not a public API.
"""
import asyncio
from aiohttp import WSMessage, WSMsgType

class DataChannelSocket:
    def __init__(self, channel, max_messages=2048):
        self.channel = channel
        self._queue = asyncio.Queue(maxsize=max_messages)
        self._closed = False
        self._error = None
        self.close_code = None
        channel.on('message', self._message)
        channel.on('close', self._end)

    @property
    def closed(self):
        return self._closed or self.channel.readyState == 'closed'

    def exception(self):
        return self._error

    def _message(self, value):
        if self.closed: return
        if not isinstance(value, (str, bytes)) or len(value) > 2**20:
            self._error = BufferError('Invalid channel message size/type')
            self.channel.close(); return
        try:
            self._queue.put_nowait(WSMessage(WSMsgType.TEXT if isinstance(value, str) else WSMsgType.BINARY, value, ''))
        except asyncio.QueueFull:
            self._error = BufferError('Native Sendspin receive queue overflow')
            self.channel.close()

    def _end(self):
        self._closed = True
        self.close_code = 1000
        while not self._queue.empty(): self._queue.get_nowait()
        self._queue.put_nowait(WSMessage(WSMsgType.CLOSED, None, ''))

    async def receive(self, timeout=None):
        if self.closed and self._queue.empty(): return WSMessage(WSMsgType.CLOSED, None, '')
        return await asyncio.wait_for(self._queue.get(), timeout) if timeout else await self._queue.get()

    async def _send(self, value):
        async with asyncio.timeout(10):
            while self.channel.bufferedAmount > 1024 * 1024 and not self.closed:
                await asyncio.sleep(.01)
            if self.closed or self.channel.readyState != 'open': raise ConnectionError('Channel closed')
            self.channel.send(value)

    async def send_str(self, value, **kwargs): await self._send(value)
    async def send_bytes(self, value, **kwargs): await self._send(value)
    async def close(self, **kwargs):
        if not self.closed: self.channel.close()
        self._end()
        return True
    def __aiter__(self): return self
    async def __anext__(self):
        msg = await self.receive()
        if msg.type in (WSMsgType.CLOSED, WSMsgType.CLOSE, WSMsgType.CLOSING): raise StopAsyncIteration
        return msg

class ChannelSession:
    """Only satisfy the SDK's ws_connect seam; deliberately cannot dial a URL."""
    def __init__(self, socket): self.socket = socket
    async def ws_connect(self, url, **kwargs):
        if url != 'wss://in-process.invalid': raise ValueError('Network dialing prohibited')
        return self.socket
