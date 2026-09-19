import importlib.util
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[1] / 'mpris.py'
spec = importlib.util.spec_from_file_location('ma_mpris', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Bridge:
    def __init__(self):
        self.calls = []
        self.ready = True
        self.player = {'player_id': 'local', 'available': True, 'volume_level': 42,
                       'volume_control': 'native', 'supported_features': ['volume_set']}
        self.queue = {'queue_id': 'local', 'state': 'playing', 'items': 2, 'current_index': 0,
                      'current_item': {'media_item': {'name': 'Song'}}}

    def status(self):
        return {'ready': self.ready, 'playerId': 'local'}

    def request(self, command, args):
        self.calls.append((command, args))
        if command == 'players/get':
            return dict(self.player)
        if command == 'player_queues/get_active_queue':
            return dict(self.queue)
        return None


class MprisTest(unittest.TestCase):
    def setUp(self):
        self.bridge = Bridge()
        self.adapter = m.Adapter(self.bridge)

    def test_commands_stay_on_the_local_queue(self):
        self.adapter.action('Play')
        self.assertEqual(self.bridge.calls[-1], ('player_queues/play', {'queue_id': 'local'}))

    def test_foreign_or_grouped_players_are_rejected(self):
        self.bridge.player = {'player_id': 'remote', 'available': True}
        with self.assertRaises(m.Unavailable):
            self.adapter.action('Play')
        self.bridge.player = {'player_id': 'local', 'available': True, 'group_members': ['remote']}
        with self.assertRaises(m.Unavailable):
            self.adapter.action('Play')
        self.assertFalse(any(c == 'player_queues/play' for c, _ in self.bridge.calls))

    def test_not_ready_does_not_talk_to_the_server(self):
        self.bridge.ready = False
        with self.assertRaises(m.Unavailable):
            self.adapter.action('Play')
        self.assertEqual(self.bridge.calls, [])

    def test_missing_volume_still_publishes(self):
        self.bridge.player = {'player_id': 'local', 'available': True}
        ident, props = self.adapter.snapshot()
        self.assertEqual(ident, 'local')
        self.assertEqual(props['Volume'], 1.0)
        self.assertEqual(props['PlaybackStatus'], 'Playing')


if __name__ == '__main__':
    unittest.main()
