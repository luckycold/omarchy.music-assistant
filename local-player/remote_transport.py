"""Isolated MA Remote-ID transport spike; no browser, Node, or frontend runtime.

Runtime dependencies: aiohttp, cryptography, aiortc (tested API: aiortc 1.15.0).
Usage (caller supplies existing, exact configuration; never log these values)::

    transport = RemoteTransport(forceRelay=False)
    try:
        await transport.connect(remote_id, signaling_url, token)
        result = await transport.rpc("players/all", {})
        channel = await transport.open_sendspin(on_message=receive_sendspin)
        # channel.send(str_or_bytes); native Sendspin/Noise/pairing lives above this.
        # await transport.rpc("sendspin/pair_web_player", {"pairing_token": ...})
    finally:
        await transport.close()

connect() returns only after {command:'auth',args:{token:...}} returns
{result:{authenticated:true}} on the ordered 'ma-api' data channel. It does NOT
pair a Sendspin player or produce audio. open_sendspin() returns an ordered raw
aiortc RTCDataChannel; supply a synchronous on_message callback before opening
so initial server messages cannot race listener installation.

Security: the canonical 26-character modified Base32 Remote ID encodes the first
16 bytes of the server certificate's SHA-256 digest (9 replaces 2). Verify EVERY
SHA-256 SDP fingerprint and remove all other algorithms BEFORE setRemoteDescription.
aiortc then verifies the actual DTLS certificate against the full advertised
SHA-256 digest before allowing data. There is no verification bypass. The
reviewed TS path has no separate AES-GCM signaling encryption or shared key.

The exact caller-provided wss URL is used, with default CA/hostname verification,
no proxy inherited from the environment, and redirects rejected before following.
There is no invented signaling hostname, LAN fallback, or credential discovery.
Signaling receives the Remote ID, SDP and ICE, never the MA API token.

forceRelay=True uses a PROTOTYPE-ONLY, exact-version-guarded private hook for
aiortc 1.15.0 / aioice 0.10.2, because aiortc has no public iceTransportPolicy.
Before gathering: require TURN, set aioice RELAY, disable host-interface candidate
gathering (both address families), and remove STUN. Setting RELAY alone is NOT
sufficient in aioice 0.10.2: it retains host protocols and can gather srflx.
Require relay-only candidates/protocols after gathering and a relay nominated
pair before API auth. Strip relay related/base addresses from outgoing SDP.
No TURN, no allocation or incompatible versions fail CLOSED, never fall back.
This private hook is offline-tested, NOT live-TURN/browser-parity verified.
False permits direct/public-STUN/TURN ICE as TS 'all'.

Single-use instances; no reconnect, renegotiation, subscriptions or playback.
RPCs: 32 pending, 64 KiB requests, 8 MiB responses, bounded deadlines; supports
partial array results and MA __chunk__ API frames. Raw Sendspin framing/flow
control is the caller's responsibility. No application logs or raw exceptions
are emitted. Dependency loggers are silenced when connecting because DEBUG SDP
and ICE logs can expose identifiers/addresses. Do not log objects, result bodies,
or traceback locals. Run offline checks: python remote_transport.py --self-test.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import json
import logging
import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlsplit

import aiohttp
from cryptography.hazmat.primitives.constant_time import bytes_eq

MAX_REQUEST = 64 * 1024
MAX_RESPONSE = 8 * 1024 * 1024
MAX_PENDING = 32
MAX_SIGNAL = 256 * 1024
MAX_CANDIDATES = 256
FALLBACK_ICE = [
    {"urls": "stun:stun.l.google.com:19302"},
    {"urls": "stun:stun.cloudflare.com:3478"},
]


class TransportError(Exception):
    """Only fixed local error codes; never interpolate peer data or credentials."""


class CertificateVerificationError(TransportError):
    pass


def decode_remote_id(remote_id: str) -> bytes:
    if not isinstance(remote_id, str) or not re.fullmatch(r"[A-Z3-79]{26}", remote_id):
        raise CertificateVerificationError("REMOTE_ID_INVALID")
    try:
        decoded = base64.b32decode(remote_id.replace("9", "2") + "======")
    except (ValueError, binascii.Error):
        raise CertificateVerificationError("REMOTE_ID_INVALID") from None
    canonical = base64.b32encode(decoded).decode("ascii").rstrip("=").replace("2", "9")
    if len(decoded) != 16 or canonical != remote_id:
        raise CertificateVerificationError("REMOTE_ID_INVALID")
    return decoded


def verify_and_sanitize_sdp(sdp: str, remote_id: str) -> str:
    expected = decode_remote_id(remote_id)
    if not isinstance(sdp, str) or not sdp or len(sdp) > MAX_SIGNAL:
        raise CertificateVerificationError("SDP_INVALID")
    lines, found = [], False
    for line in sdp.splitlines():
        if line.lower().startswith("a=fingerprint:"):
            match = re.fullmatch(r"a=fingerprint:([^\s]+)\s+(.+)", line, re.I)
            if not match:
                raise CertificateVerificationError("FINGERPRINT_INVALID")
            if match[1].lower() != "sha-256":
                continue
            # Stronger syntax validation than TS: require the entire 32-byte digest.
            if not re.fullmatch(r"(?:[0-9a-f]{2}:){31}[0-9a-f]{2}", match[2], re.I):
                raise CertificateVerificationError("FINGERPRINT_INVALID")
            digest = bytes.fromhex(match[2].replace(":", ""))
            if not bytes_eq(digest[:16], expected):
                raise CertificateVerificationError("FINGERPRINT_MISMATCH")
            found = True
            line = "a=fingerprint:sha-256 " + match[2].upper()
        lines.append(line)
    if not found:
        raise CertificateVerificationError("FINGERPRINT_MISSING")
    return "\r\n".join(lines) + "\r\n"


def _validate_url(url: str) -> None:
    try:
        p = urlsplit(url)
        if (not isinstance(url, str) or not url.startswith("wss://") or
                p.scheme != "wss" or not p.hostname or p.username is not None or
                p.password is not None or "?" in url or "#" in url or
                any(c.isspace() or ord(c) < 32 for c in url) or "\\" in url):
            raise ValueError
        _ = p.port
    except (ValueError, TypeError, AttributeError):
        raise TransportError("CONFIG_INVALID") from None


def _silence_dependency_logs() -> None:
    # Per-logger suppression also covers propagated records (root level does not).
    for name in set(logging.Logger.manager.loggerDict) | {"aiortc", "aioice", "aiohttp"}:
        if name.split(".")[0] in {"aiortc", "aioice", "aiohttp"}:
            logging.getLogger(name).disabled = True


def _check_relay_runtime() -> None:
    import aiortc
    import aioice
    if aiortc.__version__ != "1.15.0" or aioice.__version__ != "0.10.2":
        raise TransportError("RELAY_RUNTIME_UNSUPPORTED")


def _prepare_relay_only(pc):
    """Private, pinned spike hook; run before any local candidate gathering."""
    from aioice import TransportPolicy
    _check_relay_runtime()
    try:
        gatherer = pc.sctp.transport.transport.iceGatherer
        connection = gatherer._connection
        if (gatherer.state != "new" or connection._local_candidates_start or
                connection._protocols or connection._local_candidates):
            raise TransportError("RELAY_SETUP_TOO_LATE")
        if not connection.turn_server:
            raise TransportError("RELAY_TURN_REQUIRED")
        # These flags only govern local interface enumeration, not address
        # resolution or socket creation by the separate TURN endpoint helper.
        connection._use_ipv4 = False
        connection._use_ipv6 = False
        connection.stun_server = None
        connection._transport_policy = TransportPolicy.RELAY
        return connection
    except AttributeError:
        raise TransportError("RELAY_RUNTIME_UNSUPPORTED") from None


def _assert_relay_only(connection, *, selected: bool = False) -> None:
    if (not connection._local_candidates or not connection._protocols or
            any(c.type != "relay" for c in connection._local_candidates) or
            any(p.local_candidate.type != "relay" for p in connection._protocols)):
        raise TransportError("RELAY_ALLOCATION_FAILED")
    if selected and (not connection._nominated or any(
            pair.local_candidate.type != "relay" for pair in connection._nominated.values())):
        raise TransportError("RELAY_PAIR_REQUIRED")


def _relay_offer_sdp(sdp: str) -> str:
    # Candidate raddr/rport are optional. Avoid exposing TURN's observed base
    # address. This is privacy redaction, NOT the relay enforcement mechanism.
    lines = []
    for line in sdp.splitlines():
        if line.startswith("a=candidate:"):
            if not re.search(r"\btyp relay(?:\s|$)", line):
                raise TransportError("RELAY_CANDIDATE_INVALID")
            line = re.sub(r"\s+raddr\s+\S+", "", line)
            line = re.sub(r"\s+rport\s+\d+", "", line)
        lines.append(line)
    return "\r\n".join(lines) + "\r\n"


@dataclass
class _Pending:
    future: asyncio.Future
    size: int = 0
    parts: list | None = None


@dataclass
class _Chunk:
    count: int
    parts: dict[int, bytes] = field(default_factory=dict)
    size: int = 0
    timer: asyncio.TimerHandle | None = None


class RemoteTransport:
    def __init__(self, *, forceRelay: bool = False, connect_timeout: float = 65,
                 rpc_timeout: float = 30):
        if type(forceRelay) is not bool:
            raise TransportError("CONFIG_INVALID")
        for value in (connect_timeout, rpc_timeout):
            if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise TransportError("CONFIG_INVALID")
        self.forceRelay = forceRelay
        self.connect_timeout = min(connect_timeout, 120)
        self.rpc_timeout = min(rpc_timeout, 120)
        self.state = "idle"
        self.authenticated = False
        self._used = False
        self._closing = False
        self._error = "CLOSED"
        self._failed = asyncio.Event()
        self._close_lock = asyncio.Lock()
        self._http = self._ws = self._pc = self._api = None
        self._reader = self._cleanup_task = None
        self._pending: dict[str, _Pending] = {}
        self._chunks: dict[int, _Chunk] = {}
        self._next_id = 0
        self._sendspin = None
        self._relay_connection = None

    async def connect(self, remote_id: str, signaling_url: str, token: str) -> RemoteTransport:
        if self._used:
            raise TransportError("SINGLE_USE")
        self._used = True
        try:
            decode_remote_id(remote_id)
            _validate_url(signaling_url)
            if not isinstance(token, str) or not token or len(token.encode()) > MAX_REQUEST // 2:
                raise TransportError("CONFIG_INVALID")
            from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection
            if self.forceRelay:
                _check_relay_runtime()
            _silence_dependency_logs()
            self.state = "connecting"
            async with asyncio.timeout(self.connect_timeout):
                # aiohttp follows HTTP redirects internally during a WS handshake.
                # Abort its redirect trace callback BEFORE it follows Location.
                trace = aiohttp.TraceConfig()
                async def reject_redirect(*_args):
                    raise TransportError("SIGNAL_REDIRECT_REJECTED")
                trace.on_request_redirect.append(reject_redirect)
                self._http = aiohttp.ClientSession(
                    trust_env=False, trace_configs=[trace],
                    timeout=aiohttp.ClientTimeout(total=30),
                )
                self._ws = await self._http.ws_connect(
                    signaling_url, ssl=True, max_msg_size=MAX_SIGNAL, heartbeat=20,
                )
                await self._ws.send_json({"type": "connect-request", "remoteId": remote_id})
                connected = await self._receive_signal()
                if connected.get("type") != "connected":
                    raise TransportError("SIGNAL_CONNECT_FAILED")
                if connected.get("remoteId") not in (None, "", remote_id):
                    raise TransportError("SIGNAL_REMOTE_MISMATCH")
                session_id = connected.get("sessionId") or None
                if session_id is not None and not isinstance(session_id, str):
                    raise TransportError("SIGNAL_PROTOCOL")
                servers = connected.get("iceServers")
                if servers is None:
                    servers = FALLBACK_ICE
                if not isinstance(servers, list) or len(servers) > 32:
                    raise TransportError("SIGNAL_PROTOCOL")
                ice_servers = [RTCIceServer(urls=s["urls"], username=s.get("username"),
                                           credential=s.get("credential")) for s in servers]
                self._pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers))
                self._pc.on("connectionstatechange", self._peer_state)
                self._api = self._pc.createDataChannel("ma-api", ordered=True)
                if self.forceRelay:
                    self._relay_connection = _prepare_relay_only(self._pc)
                opened = asyncio.Event()
                self._api.on("open", opened.set)
                self._api.on("close", lambda: self._fail("API_CLOSED"))
                self._api.on("message", self._receive_api)
                # aiortc gathers completely in setLocalDescription; unlike the
                # browser, it does not emit trickled local icecandidate events.
                await self._pc.setLocalDescription(await self._pc.createOffer())
                offer = self._pc.localDescription
                offer_sdp = offer.sdp
                if self.forceRelay:
                    _assert_relay_only(self._relay_connection)
                    offer_sdp = _relay_offer_sdp(offer_sdp)
                await self._ws.send_json({"type": "offer", "remoteId": remote_id,
                                          "sessionId": session_id,
                                          "data": {"type": offer.type, "sdp": offer_sdp}})
                self._reader = asyncio.create_task(self._read_signals(remote_id, session_id))
                if self._api.readyState != "open":
                    await self._wait(opened.wait(), self.connect_timeout)
                if self.forceRelay:
                    _assert_relay_only(self._relay_connection, selected=True)
                self.state = "authenticating"
                auth = await self._request("auth", {"token": token}, self.rpc_timeout)
                if not isinstance(auth, dict) or auth.get("authenticated") is not True:
                    raise TransportError("AUTH_FAILED")
                if self._failed.is_set():
                    raise TransportError(self._error)
                self.authenticated = True
                self.state = "ready"
                return self
        except asyncio.CancelledError:
            await self.close()
            raise
        except Exception as exc:
            code = str(exc) if isinstance(exc, TransportError) else (
                "CONNECT_TIMEOUT" if isinstance(exc, TimeoutError) else "CONNECT_FAILED")
            self.state = "failed"
            await self.close()
            raise TransportError(code) from None

    async def _receive_signal(self) -> dict:
        message = await self._ws.receive(timeout=30)
        if message.type != aiohttp.WSMsgType.TEXT:
            raise TransportError("SIGNAL_CLOSED")
        try:
            result = json.loads(message.data)
        except (ValueError, RecursionError):
            raise TransportError("SIGNAL_PROTOCOL") from None
        if not isinstance(result, dict):
            raise TransportError("SIGNAL_PROTOCOL")
        return result

    async def _read_signals(self, remote_id: str, session_id: str | None) -> None:
        from aiortc import RTCSessionDescription
        from aiortc.sdp import candidate_from_sdp
        buffered, answered, candidate_count = [], False, 0

        async def add_candidate(data):
            if data is None or (isinstance(data, dict) and data.get("candidate") == ""):
                await self._pc.addIceCandidate(None)
                return
            if not isinstance(data, dict) or not isinstance(data.get("candidate"), str):
                raise TransportError("SIGNAL_PROTOCOL")
            raw = data["candidate"]
            if not raw.startswith("candidate:") or len(raw) > 4096:
                raise TransportError("SIGNAL_PROTOCOL")
            candidate = candidate_from_sdp(raw[len("candidate:"):])
            candidate.sdpMid = data.get("sdpMid")
            candidate.sdpMLineIndex = data.get("sdpMLineIndex")
            await self._pc.addIceCandidate(candidate)

        try:
            # No 30s idle receive deadline after the initial connected response.
            async for frame in self._ws:
                if frame.type != aiohttp.WSMsgType.TEXT:
                    raise TransportError("SIGNAL_CLOSED")
                message = json.loads(frame.data)
                if not isinstance(message, dict):
                    raise TransportError("SIGNAL_PROTOCOL")
                if message.get("sessionId") not in (None, session_id):
                    raise TransportError("SIGNAL_SESSION_MISMATCH")
                kind = message.get("type")
                if kind == "answer":
                    if answered:
                        raise TransportError("SIGNAL_RENEGOTIATION_UNSUPPORTED")
                    data = message.get("data")
                    if not isinstance(data, dict) or data.get("type") != "answer":
                        raise TransportError("SIGNAL_PROTOCOL")
                    sanitized = verify_and_sanitize_sdp(data.get("sdp"), remote_id)
                    await self._pc.setRemoteDescription(RTCSessionDescription(sdp=sanitized, type="answer"))
                    answered = True
                    for candidate in buffered:
                        await add_candidate(candidate)
                    buffered.clear()
                elif kind == "ice-candidate":
                    candidate_count += 1
                    if candidate_count > MAX_CANDIDATES:
                        raise TransportError("SIGNAL_LIMIT")
                    if answered:
                        await add_candidate(message.get("data"))
                    else:
                        buffered.append(message.get("data"))
                elif kind in {"error", "peer-disconnected"}:
                    raise TransportError("SIGNAL_PEER_FAILED")
                elif kind == "offer":
                    raise TransportError("SIGNAL_RENEGOTIATION_UNSUPPORTED")
            if not self._closing:
                self._fail("SIGNAL_CLOSED")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._fail(str(exc) if isinstance(exc, TransportError) else "SIGNAL_FAILED")

    def _peer_state(self) -> None:
        if self._pc and self._pc.connectionState in {"failed", "closed"}:
            self._fail("PEER_FAILED")

    def _fail(self, code: str) -> None:
        if self._closing or self._failed.is_set():
            return
        self._error = code
        self.state = "failed"
        self.authenticated = False
        self._failed.set()
        for entry in self._pending.values():
            if not entry.future.done():
                entry.future.set_exception(TransportError(code))
        self._cleanup_task = asyncio.create_task(self.close())

    async def _wait(self, operation, timeout: float):
        work = asyncio.ensure_future(operation)
        failed = asyncio.create_task(self._failed.wait())
        try:
            done, _ = await asyncio.wait({work, failed}, timeout=timeout,
                                         return_when=asyncio.FIRST_COMPLETED)
            if self._failed.is_set():
                raise TransportError(self._error)
            if work not in done:
                raise TimeoutError
            return work.result()
        finally:
            for task in (work, failed):
                if not task.done():
                    task.cancel()
            await asyncio.gather(work, failed, return_exceptions=True)

    async def rpc(self, command: str, args: dict | None = None, *, timeout: float | None = None):
        if not self.authenticated or self.state != "ready":
            raise TransportError("NOT_READY")
        if command == "auth" or (isinstance(command, str) and command.startswith("auth/")):
            raise TransportError("RPC_RESERVED")
        return await self._request(command, {} if args is None else args,
                                   self.rpc_timeout if timeout is None else timeout)

    async def _request(self, command: str, args: dict, timeout: float):
        if not isinstance(command, str) or len(command) > 160 or not re.fullmatch(
                r"[a-z][a-z0-9_]*(?:/[a-z][a-z0-9_]*)*", command) or not isinstance(args, dict):
            raise TransportError("RPC_INVALID")
        if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 120:
            raise TransportError("RPC_INVALID")
        if self._failed.is_set() or not self._api or self._api.readyState != "open":
            raise TransportError("RPC_CLOSED")
        if len(self._pending) >= MAX_PENDING:
            raise TransportError("RPC_LIMIT")
        self._next_id += 1
        ident = f"player-{self._next_id}"
        try:
            text = json.dumps({"message_id": ident, "command": command, "args": args},
                              separators=(",", ":"), allow_nan=False)
        except (ValueError, TypeError, RecursionError):
            raise TransportError("RPC_INVALID") from None
        if len(text.encode()) > MAX_REQUEST or self._api.bufferedAmount > MAX_REQUEST:
            raise TransportError("RPC_LIMIT")
        future = asyncio.get_running_loop().create_future()
        self._pending[ident] = _Pending(future)
        try:
            self._api.send(text)
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            raise TransportError("RPC_TIMEOUT") from None
        except TransportError:
            raise
        except Exception:
            raise TransportError("RPC_SEND") from None
        finally:
            self._pending.pop(ident, None)
            if not future.done():
                future.cancel()

    def _drop_chunk(self, ident: int) -> None:
        chunk = self._chunks.pop(ident, None)
        if chunk and chunk.timer:
            chunk.timer.cancel()

    def _chunk(self, msg: dict) -> str | None:
        ident, seq, count, encoded = (msg.get(k) for k in ("id", "seq", "count", "b64"))
        if (any(type(x) is not int for x in (ident, seq, count)) or
                not 0 <= ident <= 2**53 - 1 or not 1 <= count <= 1024 or
                not 0 <= seq < count or not isinstance(encoded, str) or
                not 0 < len(encoded) <= 87384):
            raise TransportError("RPC_CHUNK_INVALID")
        try:
            part = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise TransportError("RPC_CHUNK_INVALID") from None
        chunk = self._chunks.get(ident)
        if chunk and chunk.count != count:
            raise TransportError("RPC_CHUNK_INVALID")
        if chunk and seq in chunk.parts:
            return None
        if sum(g.size for g in self._chunks.values()) + len(part) > MAX_RESPONSE:
            raise TransportError("RPC_LIMIT")
        if chunk is None:
            if len(self._chunks) >= 32:
                raise TransportError("RPC_LIMIT")
            chunk = self._chunks[ident] = _Chunk(count)
            chunk.timer = asyncio.get_running_loop().call_later(30, self._drop_chunk, ident)
        chunk.parts[seq] = part
        chunk.size += len(part)
        if len(chunk.parts) != count:
            return None
        self._drop_chunk(ident)
        return b"".join(chunk.parts[i] for i in range(count)).decode("utf-8")

    def _receive_api(self, text: str) -> None:
        try:
            if not isinstance(text, str) or len(text.encode()) > MAX_RESPONSE:
                raise TransportError("RPC_LIMIT")
            msg = json.loads(text)
            if isinstance(msg, dict) and msg.get("type") == "__chunk__":
                text = self._chunk(msg)
                if text is None:
                    return
                msg = json.loads(text)
            if not isinstance(msg, dict) or not isinstance(msg.get("message_id"), str):
                return  # initial server metadata and unsolicited events are ignored
            entry = self._pending.get(msg["message_id"])
            if entry is None or entry.future.done():
                return
            entry.size += len(text.encode())
            if entry.size > MAX_RESPONSE:
                entry.future.set_exception(TransportError("RPC_LIMIT"))
            elif "error_code" in msg:
                entry.future.set_exception(TransportError("RPC_REMOTE"))
            elif "result" not in msg:
                entry.future.set_exception(TransportError("RPC_PROTOCOL"))
            elif msg.get("partial") is True or entry.parts is not None:
                if not isinstance(msg["result"], list):
                    entry.future.set_exception(TransportError("RPC_PROTOCOL"))
                    return
                if entry.parts is None:
                    entry.parts = []
                entry.parts.extend(msg["result"])
                if msg.get("partial") is not True:
                    entry.future.set_result(entry.parts)
            else:
                entry.future.set_result(msg["result"])
        except Exception as exc:
            self._fail(str(exc) if isinstance(exc, TransportError) else "RPC_PROTOCOL")

    async def open_sendspin(self, on_message: Callable[[str | bytes], None] | None = None, *, wait: bool = True):
        if not self.authenticated or self.state != "ready":
            raise TransportError("NOT_READY")
        if self._sendspin is not None:
            raise TransportError("CHANNEL_ALREADY_CREATED")
        channel = self._sendspin = self._pc.createDataChannel("sendspin", ordered=True)
        opened = asyncio.Event()
        channel.on("open", opened.set)
        channel.on("close", lambda: self._fail("SENDSPIN_CLOSED"))
        if on_message is not None:
            channel.on("message", on_message)
        if not wait:
            return channel
        try:
            if channel.readyState != "open":
                await self._wait(opened.wait(), 10)
            return channel
        except asyncio.CancelledError:
            channel.close()
            raise
        except Exception:
            channel.close()
            raise TransportError("CHANNEL_OPEN_FAILED") from None

    async def close(self) -> None:
        async with self._close_lock:
            if self._closing:
                return
            self._closing = True
            self._used = True
            self.authenticated = False
            self._failed.set()
            if self.state != "failed":
                self.state = "closed"
            for entry in self._pending.values():
                if not entry.future.done():
                    entry.future.set_exception(TransportError("RPC_CLOSED"))
            for ident in list(self._chunks):
                self._drop_chunk(ident)
            if self._reader and self._reader is not asyncio.current_task():
                self._reader.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._reader
            # Attempt every cleanup even if one dependency fails; never emit its
            # exception text. Deadline prevents teardown stalling the caller.
            for resource in (self._pc, self._ws, self._http):
                if resource:
                    with contextlib.suppress(Exception):
                        await asyncio.wait_for(resource.close(), 5)
            self._api = self._pc = self._ws = self._http = None


async def connect(remote_id: str, signaling_url: str, token: str, *,
                  forceRelay: bool = False) -> RemoteTransport:
    """Convenience factory; caller must await returned transport.close()."""
    return await RemoteTransport(forceRelay=forceRelay).connect(remote_id, signaling_url, token)


def _self_test() -> None:
    """Offline tests only; fake signaling/peer, real crypto and aiortc SDP types."""
    import unittest
    from types import SimpleNamespace
    from unittest.mock import patch
    from aiortc import RTCCertificate
    from cryptography.hazmat.primitives import hashes

    def remote_id(digest):
        return base64.b32encode(digest[:16]).decode().rstrip("=").replace("2", "9")

    digest = bytes(range(32))
    rid = remote_id(digest)
    fingerprint = ":".join(f"{b:02X}" for b in digest)
    sdp = "v=0\r\na=fingerprint:sha-256 " + fingerprint + "\r\n"

    class CryptoTests(unittest.TestCase):
        def test_canonical(self):
            self.assertEqual(decode_remote_id(rid), digest[:16])
            for bad in (rid.lower(), rid + "=", " " + rid, "A" * 25 + "B", "2" * 26):
                with self.assertRaises(CertificateVerificationError):
                    decode_remote_id(bad)

        def test_all_fingerprints_and_algorithm_substitution(self):
            result = verify_and_sanitize_sdp(sdp + "a=fingerprint:sha-512 DE:AD\r\n" + sdp, rid)
            self.assertNotIn("sha-512", result)
            self.assertEqual(result.count("sha-256"), 2)
            for bad in ("v=0\r\n", sdp.replace("00:01", "FF:01"),
                        sdp + sdp.replace("00:01", "FF:01"),
                        sdp.replace(fingerprint, "00:01"),
                        sdp.replace("sha-256", "sha-512")):
                with self.assertRaises(CertificateVerificationError):
                    verify_and_sanitize_sdp(bad, rid)

        def test_real_certificate(self):
            cert = RTCCertificate.generateCertificate()
            # Independent cryptography digest agrees with aiortc's fingerprint.
            actual = cert._cert.fingerprint(hashes.SHA256())
            fp = next(x.value for x in cert.getFingerprints() if x.algorithm == "sha-256")
            verified = verify_and_sanitize_sdp("a=fingerprint:sha-256 " + fp, remote_id(actual))
            self.assertIn(fp, verified)

        def test_aiortc_dtls_checks_full_certificate_digest(self):
            from aiortc.rtcdtlstransport import RTCDtlsTransport, RTCDtlsParameters, RTCDtlsFingerprint, State
            cert = RTCCertificate.generateCertificate()
            fp = next(x.value for x in cert.getFingerprints() if x.algorithm == "sha-256")
            states = []
            # Exercise installed aiortc identity validation, using a fake SSL
            # certificate accessor only (no handshake, ICE, sockets or service).
            peer = SimpleNamespace(
                _ssl=SimpleNamespace(get_peer_certificate=lambda **_: cert._cert),
                _set_state=states.append,
            )
            setattr(peer, "_RTCDtlsTransport__log_debug", lambda *_: None)
            RTCDtlsTransport._validate_peer_identity(peer, RTCDtlsParameters(
                fingerprints=[RTCDtlsFingerprint("sha-256", fp)]))
            self.assertFalse(states)
            # Same Remote-ID prefix, different second half: SDP prefix check
            # intentionally succeeds, but the actual certificate must fail.
            changed = fp[:-2] + ("01" if fp[-2:] == "00" else "00")
            actual = cert._cert.fingerprint(hashes.SHA256())
            verify_and_sanitize_sdp("a=fingerprint:sha-256 " + changed, remote_id(actual))
            RTCDtlsTransport._validate_peer_identity(peer, RTCDtlsParameters(
                fingerprints=[RTCDtlsFingerprint("sha-256", changed)]))
            self.assertEqual(states, [State.FAILED])

        def test_url_rejection(self):
            _validate_url("wss://signaling.example.invalid/exact/path")
            for url in ("ws://example.invalid", "wss://user@example.invalid", "wss://x/?q=1",
                        "wss://x/#x", "wss://x/\n", "wss://x:invalid"):
                with self.assertRaises(TransportError):
                    _validate_url(url)

    class Channel:
        def __init__(self, label):
            self.label, self.readyState, self.bufferedAmount = label, "open", 0
            self.handlers, self.sent = {}, []
        def on(self, event, handler):
            self.handlers[event] = handler
        def send(self, text):
            self.sent.append(json.loads(text))
            msg = self.sent[-1]
            result = {"authenticated": True} if msg["command"] == "auth" else []
            self.handlers["message"](json.dumps({"message_id": msg["message_id"], "result": result}))
        def close(self):
            self.readyState = "closed"

    class AsyncTests(unittest.IsolatedAsyncioTestCase):
        async def test_rpc_partial_chunk_timeout_and_close(self):
            t = RemoteTransport(rpc_timeout=0.01)
            t._api = Channel("ma-api")
            t._api.on("message", t._receive_api)
            t.authenticated, t.state = True, "ready"
            self.assertEqual(await t.rpc("players/all"), [])
            t._api.send = lambda text: None
            task = asyncio.create_task(t.rpc("players/all"))
            await asyncio.sleep(0)
            ident = next(iter(t._pending))
            t._receive_api(json.dumps({"message_id": ident, "result": [1], "partial": True}))
            payload = json.dumps({"message_id": ident, "result": [2]}).encode()
            parts = [payload[:10], payload[10:]]
            for seq in (1, 0):
                t._receive_api(json.dumps({"type": "__chunk__", "id": 3, "seq": seq,
                    "count": 2, "b64": base64.b64encode(parts[seq]).decode()}))
            self.assertEqual(await task, [1, 2])
            self.assertFalse(t._chunks)
            with self.assertRaisesRegex(TransportError, "RPC_TIMEOUT"):
                await t.rpc("players/all")
            self.assertFalse(t._pending)
            task = asyncio.create_task(t.rpc("players/all"))
            await asyncio.sleep(0)
            await t.close()
            with self.assertRaisesRegex(TransportError, "RPC_CLOSED"):
                await task

        async def test_relay_wrong_version_fails_before_network(self):
            import aioice
            with patch.object(aioice, "__version__", "unsupported"), patch.object(
                    aiohttp, "ClientSession", side_effect=AssertionError("network prohibited")):
                with self.assertRaisesRegex(TransportError, "RELAY_RUNTIME_UNSUPPORTED"):
                    await RemoteTransport(forceRelay=True).connect(rid, "wss://test.invalid", "test-only")

        async def test_relay_real_gatherer_with_fake_turn_no_host_sockets(self):
            from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection
            from aioice import Candidate, TransportPolicy
            import aioice.ice
            pc = RTCPeerConnection(RTCConfiguration(iceServers=[
                RTCIceServer("stun:stun.example.invalid:3478"),
                RTCIceServer("turn:turn.example.invalid:3478", username="test", credential="test")]))
            pc.createDataChannel("ma-api")
            connection = _prepare_relay_only(pc)
            self.assertEqual(connection._transport_policy, TransportPolicy.RELAY)
            self.assertFalse(connection._use_ipv4 or connection._use_ipv6)
            self.assertIsNone(connection.stun_server)
            candidate = Candidate(foundation="offline", component=1, transport="udp",
                                  priority=1, host="192.0.2.1", port=1234, type="relay")
            class Protocol:
                local_candidate = candidate
                async def close(self): pass
            async def fake_turn(**_kwargs): return candidate, Protocol()
            loop = asyncio.get_running_loop()
            try:
                with patch.object(aioice.ice, "relayed_candidate", fake_turn), patch.object(
                        loop, "create_datagram_endpoint", side_effect=AssertionError("host socket prohibited")):
                    await pc.sctp.transport.transport.iceGatherer.gather()
                _assert_relay_only(connection)
                with self.assertRaisesRegex(TransportError, "RELAY_PAIR_REQUIRED"):
                    _assert_relay_only(connection, selected=True)
                connection._nominated[1] = SimpleNamespace(local_candidate=candidate)
                _assert_relay_only(connection, selected=True)
                candidate.type = "host"
                with self.assertRaisesRegex(TransportError, "RELAY_ALLOCATION_FAILED"):
                    _assert_relay_only(connection)
            finally:
                await pc.close()
            no_turn = RTCPeerConnection(RTCConfiguration(iceServers=[]))
            try:
                no_turn.createDataChannel("ma-api")
                with self.assertRaisesRegex(TransportError, "RELAY_TURN_REQUIRED"):
                    _prepare_relay_only(no_turn)
            finally:
                await no_turn.close()

        async def test_relay_sdp_privacy(self):
            offer = "a=candidate:1 1 udp 1 192.0.2.1 1234 typ relay raddr 192.0.2.2 rport 5678\r\n"
            redacted = _relay_offer_sdp(offer)
            self.assertNotIn("raddr", redacted)
            self.assertNotIn("rport", redacted)
            self.assertNotIn("192.0.2.2", redacted)
            with self.assertRaisesRegex(TransportError, "RELAY_CANDIDATE_INVALID"):
                _relay_offer_sdp(offer.replace("typ relay", "typ host"))

        async def test_fake_connect_and_fingerprint_gate(self):
            import aiortc
            for valid in (True, False):
                channels = []
                gate = asyncio.Event()
                applied = []
                signal_sent = []
                class Peer:
                    connectionState = "connected"
                    localDescription = SimpleNamespace(type="offer", sdp="offline-fake-offer")
                    def __init__(self, *_args): pass
                    def on(self, *_args): pass
                    def createDataChannel(self, label, **kwargs):
                        self.assert_ordered = kwargs["ordered"]
                        ch = Channel(label)
                        if label == "ma-api": ch.readyState = "connecting"
                        channels.append(ch)
                        return ch
                    async def createOffer(self): return self.localDescription
                    async def setLocalDescription(self, _offer): pass
                    async def setRemoteDescription(self, description):
                        applied.append(description.sdp)
                        channels[0].readyState = "open"
                        channels[0].handlers["open"]()
                    async def addIceCandidate(self, _candidate): pass
                    async def close(self): pass
                class WS:
                    async def send_json(self, msg): signal_sent.append(msg)
                    async def receive(self, **_kwargs):
                        return SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(
                            {"type": "connected", "sessionId": "offline", "iceServers": []}))
                    def __aiter__(self): return self.frames()
                    async def frames(self):
                        yield SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(
                            {"type": "answer", "data": {"type": "answer", "sdp": sdp if valid else sdp.replace("00:01", "FF:01")}}))
                        await gate.wait()
                    async def close(self): pass
                class HTTP:
                    def __init__(self, **_kwargs): pass
                    async def ws_connect(self, url, **_kwargs):
                        if url != "wss://test.invalid/exact": raise AssertionError
                        return WS()
                    async def close(self): pass
                t = RemoteTransport()
                with patch.object(aiohttp, "ClientSession", HTTP), patch.object(aiortc, "RTCPeerConnection", Peer):
                    if valid:
                        await t.connect(rid, "wss://test.invalid/exact", "test-only")
                        self.assertTrue(t.authenticated)
                        self.assertEqual(channels[0].sent[0]["command"], "auth")
                        self.assertEqual(channels[0].sent[0]["args"], {"token": "test-only"})
                        ch = await t.open_sendspin(on_message=lambda _: None)
                        self.assertEqual(ch.label, "sendspin")
                        self.assertEqual(len(applied), 1)
                    else:
                        with self.assertRaisesRegex(TransportError, "FINGERPRINT_MISMATCH"):
                            await t.connect(rid, "wss://test.invalid/exact", "test-only")
                        self.assertFalse(applied)
                        self.assertFalse(channels[0].sent)
                    self.assertNotIn("test-only", json.dumps(signal_sent))
                    await t.close()

    suite = unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(c)
                               for c in (CryptoTests, AsyncTests)])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["--self-test"]:
        _self_test()
    else:
        raise SystemExit("Import RemoteTransport or run --self-test (offline only).")
