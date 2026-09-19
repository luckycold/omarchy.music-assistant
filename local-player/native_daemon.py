"""Native Remote-ID player daemon. Speaks the existing omarchy-ma-player socket protocol."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aiosendspin.client import SendspinClient
from aiosendspin.models.core import DeviceInfo
from aiosendspin.models.player import ClientHelloPlayerSupport, SupportedAudioFormat
from aiosendspin.models.types import AudioCodec, Roles
from aiosendspin.noise.keys import Identity, generate_psk, psk_id_for
from aiosendspin.noise.pairing_token import PSKPairingToken, encode_token
from aiosendspin.noise.trust_store import FileClientPairingStore, PairingPsk
from native_adapter import ChannelSession, DataChannelSocket
from remote_transport import RemoteTransport, TransportError, _validate_url

MAX_REQUEST = 64 * 1024
MAX_RESPONSE = 8 * 1024 * 1024
MAX_PENDING = 32
COMMAND_RE = re.compile(r"^[a-z][a-z0-9_]*(?:/[a-z][a-z0-9_]*)*$")
PLAYER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
PHASES = {
    "idle", "unlocking", "remote-connecting", "authenticating", "opening-sendspin",
    "sdk-connecting", "pairing", "waiting-player", "ready", "failed", "disconnected",
    "starting", "reconnecting", "stopped",
}


def config_path(home: Path, config_home: str | None) -> Path:
    base = Path(config_home) if config_home else home / ".config"
    return base / "music-assistant" / "config.json"


def load_config(path: Path) -> dict:
    st = path.lstat()
    if not path.is_file() or st.st_uid != os.getuid() or st.st_mode & 0o077 or st.st_size > 65536:
        raise RuntimeError("CONFIG_PRIVATE")
    data = json.loads(path.read_text())
    player = data.get("localPlayer")
    if not isinstance(player, dict) or player.get("enabled") is not True:
        raise RuntimeError("CONFIG_DISABLED")
    token = data.get("token")
    remote_id = player.get("remoteId")
    signaling = player.get("signalingUrl")
    if not isinstance(token, str) or not token or len(token) > 16384:
        raise RuntimeError("CONFIG_INVALID")
    if not isinstance(remote_id, str) or not re.fullmatch(r"[A-Z3-79]{26}", remote_id):
        raise RuntimeError("CONFIG_INVALID")
    if not isinstance(signaling, str):
        raise RuntimeError("CONFIG_INVALID")
    try:
        _validate_url(signaling)
    except TransportError:
        raise RuntimeError("CONFIG_INVALID") from None
    name = player.get("name", "This device")
    if not isinstance(name, str) or not name.strip() or len(name) > 80 or any(ord(c) < 32 for c in name):
        raise RuntimeError("CONFIG_INVALID")
    force = player.get("forceRelay", False)
    if force is not True and force is not False:
        raise RuntimeError("CONFIG_INVALID")
    return {"token": token, "remoteId": remote_id, "signalingUrl": signaling,
            "name": name.strip(), "forceRelay": force}


def validate_request(value):
    if (not isinstance(value, dict) or not isinstance(value.get("command"), str)
            or not COMMAND_RE.fullmatch(value["command"]) or len(value["command"]) > 160
            or not isinstance(value.get("args"), dict) or isinstance(value.get("args"), list)):
        raise ValueError("BAD_REQUEST")
    command = value["command"]
    if command == "auth" or command.startswith("auth/") or command == "sendspin/pair_web_player":
        raise ValueError("RPC_RESERVED")
    if len(json.dumps(value, separators=(",", ":"))) > MAX_REQUEST:
        raise ValueError("RPC_LIMIT")
    return command, value["args"]


def safe_code(value, fallback="INTERNAL"):
    codes = {
        "RPC_REMOTE", "RPC_SEND", "RPC_TIMEOUT", "RPC_CLOSED", "RPC_PROTOCOL", "RPC_LIMIT",
        "CHANNEL_CLOSED", "CHANNEL_INVALID", "CHANNEL_ERROR", "NOT_READY", "RPC_RESERVED",
        "BAD_REQUEST", "BRIDGE_CLOSED", "CONNECT_TIMEOUT", "AUTH_FAILED", "CONFIG_INVALID",
        "CONFIG_PRIVATE", "CONFIG_DISABLED", "PLAYER_NOT_READY", "INTERNAL",
    }
    return value if isinstance(value, str) and value in codes else fallback


class NativePlayer:
    def __init__(self, home: Path, *, config_home: str | None = None):
        self.home = home
        self.config_home = config_home
        self.state = home / ".local/state/music-assistant-player"
        self.native = self.state
        self.socket_path = self.state / "player.sock"
        self.phase = "starting"
        self.ready = False
        self.playing = False
        self.error = None
        self.authenticated = False
        self.paired = False
        self.codec = None
        self.received_bytes = 0
        self.candidate = None
        self._identity = None
        self._transport = None
        self._client = None
        self._handler = None
        self._server = None
        self._stop = asyncio.Event()
        self._rpc_lock = asyncio.Semaphore(MAX_PENDING)

    @property
    def player_id(self):
        value = self._identity.peer_id if self._identity else None
        return value if isinstance(value, str) and PLAYER_ID_RE.fullmatch(value) else None

    def status(self):
        phase = self.phase if self.phase in PHASES else "starting"
        return {
            "phase": phase,
            "ready": phase == "ready" and self.ready is True,
            "playerId": self.player_id,
            "playing": self.playing is True,
            "error": safe_code(self.error) if self.error else None,
            "authenticated": self.authenticated is True,
            "paired": self.paired is True,
            "playerAvailable": self.ready is True,
            "apiConnected": self.authenticated is True,
            "sendspinConnected": bool(self._client and self._client.connected),
            "timeSynced": bool(self._client and self._client.is_time_synchronized()),
            "codec": self.codec if self.codec in {"opus", "pcm", "flac"} else None,
            "transport": {"localCandidateType": self.candidate if self.candidate in
                          {"host", "srflx", "prflx", "relay"} else None,
                          "receivedBytes": int(self.received_bytes)},
            "channel": {"rxBinary": 0, "rxBytes": int(self.received_bytes)},
            "lastHealthFailure": None,
        }

    async def start(self):
        os.umask(0o077)
        logging.disable(logging.CRITICAL)
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.state, 0o700)
        self.native.mkdir(mode=0o700, parents=True, exist_ok=True)
        key = self.native / "identity.key"
        if not key.exists():
            key.write_bytes(Identity.generate().private_bytes)
            os.chmod(key, 0o600)
        st = key.lstat()
        if not key.is_file() or st.st_uid != os.getuid() or st.st_mode & 0o077:
            raise RuntimeError("CONFIG_PRIVATE")
        self._identity = Identity.from_private_bytes(key.read_bytes())
        if self.socket_path.exists():
            self.socket_path.unlink()
        self._server = await asyncio.start_unix_server(self._ipc, path=str(self.socket_path))
        os.chmod(self.socket_path, 0o600)
        asyncio.create_task(self._run())
        async with self._server:
            await self._stop.wait()

    async def close(self):
        self._stop.set()
        await self._teardown()
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        if self.socket_path.exists():
            self.socket_path.unlink()

    async def _run(self):
        delay = 1
        while not self._stop.is_set():
            failed = False
            try:
                await self._session()
                delay = 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                failed = True
                self.phase = "reconnecting"
                self.ready = False
                self.authenticated = False
                self.paired = False
                self.playing = False
                self.error = safe_code(str(exc) if isinstance(exc, TransportError) else "CONNECT_TIMEOUT")
            await self._teardown()
            if self._stop.is_set():
                return
            if failed:
                try:
                    await asyncio.wait_for(self._stop.wait(), delay)
                except asyncio.TimeoutError:
                    pass
                delay = min(delay * 2, 30)

    async def _session(self):
        cfg = load_config(config_path(self.home, self.config_home))
        store = await FileClientPairingStore.open(self.native / "pairings.json")
        psk = generate_psk()
        await store.set_pairing_psk(PairingPsk(psk_id=psk_id_for(psk), psk=psk))
        identity = self._identity
        if identity is None:
            raise RuntimeError("CONFIG_PRIVATE")
        token = encode_token(PSKPairingToken(identity.peer_id, psk))
        player_id = identity.peer_id
        self.phase = "remote-connecting"
        transport = RemoteTransport(forceRelay=bool(cfg["forceRelay"]))
        self._transport = transport
        await transport.connect(cfg["remoteId"], cfg["signalingUrl"], cfg["token"])
        self.authenticated = True
        self.phase = "opening-sendspin"
        self._record_candidate(transport)
        channel = await transport.open_sendspin(wait=False)
        socket = DataChannelSocket(channel)
        if channel.readyState != "open":
            opened = asyncio.Event()
            channel.on("open", opened.set)
            await asyncio.wait_for(opened.wait(), 10)
        client = SendspinClient(
            session=ChannelSession(socket), identity=self._identity, pairing_store=store,
            client_name=cfg["name"],
            device_info=DeviceInfo(product_name="Web Player", manufacturer="Music Assistant",
                                   software_version="native-0.1"),
            roles=[Roles.PLAYER],
            player_support=ClientHelloPlayerSupport(
                supported_formats=[SupportedAudioFormat(codec=codec, channels=2, sample_rate=rate, bit_depth=16)
                                   for codec in (AudioCodec.FLAC, AudioCodec.PCM) for rate in (48000, 44100)],
                buffer_capacity=8 * 1024 * 1024, supported_commands=[]),
        )
        self._client = client
        from sendspin.audio_connector import AudioStreamHandler
        from sendspin.audio_devices import resolve_audio_device
        handler = AudioStreamHandler(resolve_audio_device(None), volume=100, muted=False,
                                     on_format_change=self._on_format)
        handler.attach_client(client)
        self._handler = handler
        client.add_stream_start_listener(lambda _msg: setattr(self, "playing", True))
        client.add_stream_end_listener(lambda _roles: setattr(self, "playing", False))
        client.add_audio_chunk_listener(lambda _ts, payload, _fmt: setattr(
            self, "received_bytes", self.received_bytes + len(payload)))
        self.phase = "sdk-connecting"
        await asyncio.wait_for(client.connect("wss://in-process.invalid"), 20)
        self.phase = "pairing"
        await transport.rpc("sendspin/pair_web_player", {"pairing_token": token}, timeout=45)
        self.paired = True
        self.phase = "waiting-player"
        async with asyncio.timeout(25):
            while True:
                player = await transport.rpc("players/get", {"player_id": player_id})
                if (isinstance(player, dict) and player.get("player_id") == player_id
                        and player.get("available") is True and client.connected):
                    break
                await asyncio.sleep(0.4)
        self.phase = "ready"
        self.ready = True
        self.error = None
        closed = asyncio.Event()
        client.add_disconnect_listener(closed.set)
        fail = asyncio.create_task(transport._failed.wait())
        done = asyncio.create_task(closed.wait())
        stop = asyncio.create_task(self._stop.wait())
        try:
            await asyncio.wait({fail, done, stop}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (fail, done, stop):
                task.cancel()
        self.ready = False
        self.phase = "disconnected"

    def _record_candidate(self, transport):
        try:
            conn = transport._pc.sctp.transport.transport.iceGatherer._connection
            types = {p.local_candidate.type for p in conn._nominated.values()}
            self.candidate = next(iter(types)) if len(types) == 1 else None
        except Exception:
            self.candidate = None

    def _on_format(self, codec, rate, depth, channels):
        self.codec = codec

    async def _teardown(self):
        handler, client, transport = self._handler, self._client, self._transport
        self._handler = self._client = self._transport = None
        self.playing = False
        if handler:
            try:
                handler.detach_client()
                await handler.handle_disconnect()
            except Exception:
                pass
        if client:
            try:
                await asyncio.wait_for(client.disconnect(), 5)
            except Exception:
                pass
        if transport:
            try:
                await transport.close()
            except Exception:
                pass

    async def _ipc(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            data = await asyncio.wait_for(reader.readuntil(b"\n"), 35)
            if len(data) > MAX_REQUEST:
                await self._reply(writer, {"error": "RPC_LIMIT"})
                return
            extra = await reader.read(1)
            if extra:
                await self._reply(writer, {"error": "BAD_REQUEST"})
                return
            try:
                command, args = validate_request(json.loads(data[:-1]))
            except ValueError as exc:
                await self._reply(writer, {"error": safe_code(str(exc), "BAD_REQUEST")})
                return
            if command == "local/status":
                await self._reply(writer, {"result": self.status()})
                return
            if not self.ready or self._transport is None:
                await self._reply(writer, {"error": "NOT_READY"})
                return
            async with self._rpc_lock:
                try:
                    result = await self._transport.rpc(command, args, timeout=30)
                    await self._reply(writer, {"result": result})
                except TransportError as exc:
                    await self._reply(writer, {"error": safe_code(str(exc))})
        except Exception:
            try:
                await self._reply(writer, {"error": "BRIDGE_CLOSED"})
            except Exception:
                pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _reply(self, writer, obj):
        text = json.dumps(obj, separators=(",", ":"), default=str)
        if len(text.encode()) > MAX_RESPONSE:
            text = json.dumps({"error": "RPC_LIMIT"})
        writer.write(text.encode() + b"\n")
        await writer.drain()


async def _main():
    player = NativePlayer(Path.home(), config_home=os.environ.get("XDG_CONFIG_HOME"))
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(player.close()))
    try:
        await player.start()
    except Exception:
        raise SystemExit("PLAYER_START_FAILED")


if __name__ == "__main__":
    asyncio.run(_main())
