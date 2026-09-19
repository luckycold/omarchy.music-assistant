import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_daemon import config_path, load_config, validate_request


class ValidateTest(unittest.TestCase):
    def test_reserved(self):
        for command in ("auth", "auth/login", "sendspin/pair_web_player"):
            with self.assertRaises(ValueError) as ctx:
                validate_request({"command": command, "args": {}})
            self.assertEqual(str(ctx.exception), "RPC_RESERVED")


class ConfigTest(unittest.TestCase):
    def test_mode_and_enabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps({
                "token": "x" * 8,
                "localPlayer": {
                    "enabled": True,
                    "remoteId": "AAAAAAAAAAAAAAAAAAAAAAAAAA",
                    "signalingUrl": "wss://signaling.example.test/ws",
                    "name": "This device",
                    "forceRelay": False,
                },
            }))
            os.chmod(path, 0o600)
            cfg = load_config(path)
            self.assertEqual(cfg["name"], "This device")
            self.assertFalse(cfg["forceRelay"])
            os.chmod(path, 0o644)
            with self.assertRaises(RuntimeError):
                load_config(path)

    def test_signaling_url_must_be_secure(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            payload = {
                "token": "x" * 8,
                "localPlayer": {
                    "enabled": True,
                    "remoteId": "AAAAAAAAAAAAAAAAAAAAAAAAAA",
                    "signalingUrl": "http://signaling.example.test/ws",
                    "name": "This device",
                    "forceRelay": False,
                },
            }
            path.write_text(json.dumps(payload))
            os.chmod(path, 0o600)
            with self.assertRaises(RuntimeError):
                load_config(path)

    def test_xdg_config_home(self):
        home = Path('/tmp/ma-home')
        self.assertEqual(config_path(home, None), home / '.config/music-assistant/config.json')
        self.assertEqual(config_path(home, ''), home / '.config/music-assistant/config.json')
        self.assertEqual(config_path(home, '/custom/config'), Path('/custom/config/music-assistant/config.json'))


class SocketPermTest(unittest.IsolatedAsyncioTestCase):
    async def test_status_socket_is_private(self):
        import asyncio
        from native_daemon import NativePlayer

        class Fake(NativePlayer):
            async def _run(self):
                await self._stop.wait()

        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            player = Fake(home)
            player.phase = "ready"
            player.ready = True
            task = asyncio.create_task(player.start())
            for _ in range(50):
                if player.socket_path.exists():
                    break
                await asyncio.sleep(0.02)
            mode = player.socket_path.lstat().st_mode
            self.assertTrue(stat.S_ISSOCK(mode))
            self.assertEqual(mode & 0o777, 0o600)
            async def request(payload):
                reader, writer = await asyncio.open_unix_connection(str(player.socket_path))
                writer.write(payload)
                await writer.drain()
                writer.write_eof()
                data = await reader.readline()
                writer.close()
                await writer.wait_closed()
                return json.loads(data)
            reply = await request(b'{"command":"local/status","args":{}}\n')
            self.assertTrue(reply["result"]["ready"])
            reply = await request(b'{"command":"auth","args":{}}\n')
            self.assertEqual(reply["error"], "RPC_RESERVED")
            await player.close()
            await asyncio.wait_for(task, 2)


if __name__ == "__main__":
    unittest.main()
