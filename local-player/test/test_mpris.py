import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / 'mpris.py'
spec = importlib.util.spec_from_file_location('ma_mpris', PATH)
m = importlib.util.module_from_spec(spec)
if PATH.exists():
    spec.loader.exec_module(m)


class Bridge:
    def __init__(self):
        self.calls = []
        self.statuses = []
        self.ready = True
        self.player = {'player_id': 'local', 'available': True, 'volume_level': 42,
                       'volume_control': 'native', 'supported_features': ['volume_set']}
        self.queue = {'queue_id': 'local', 'state': 'playing', 'items': 2,
                      'current_index': 0, 'elapsed_time': 12,
                      'current_item': {'queue_item_id': 'track', 'duration': 30,
                                       'media_item': {'name': 'Song', 'artists': [{'name': 'Artist'}],
                                                      'album': {'name': 'Album'}}}}

    def status(self):
        return self.statuses.pop(0) if self.statuses else {'ready': self.ready, 'playerId': 'local'}

    def request(self, command, args):
        self.calls.append((command, args))
        if command == 'players/get':
            return dict(self.player)
        if command == 'player_queues/get_active_queue':
            return dict(self.queue)
        return None


class MprisTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(m, 'Adapter'), 'MPRIS adapter not implemented')
        self.bridge = Bridge()
        self.adapter = m.Adapter(self.bridge)

    def test_local_only_command_map(self):
        for method, command in [('Play', 'play'), ('Pause', 'pause'), ('PlayPause', 'play_pause'),
                                ('Stop', 'stop'), ('Next', 'next'), ('Previous', 'previous')]:
            self.adapter.action(method)
            self.assertEqual(self.bridge.calls[-1], ('player_queues/' + command, {'queue_id': 'local'}))
        self.assertTrue(all(args.get('player_id', args.get('queue_id')) == 'local'
                            for _, args in self.bridge.calls))

    def test_not_ready(self):
        self.bridge.ready = False
        with self.assertRaises(m.Unavailable): self.adapter.action('Play')
        self.assertEqual(self.bridge.calls, [])

    def test_disconnected_and_wrong_player(self):
        for player in [{'player_id': 'local', 'available': False}, {'player_id': 'remote', 'available': True}]:
            self.bridge.player = player
            with self.assertRaises(m.Unavailable): self.adapter.action('Play')
        self.assertFalse(any(c == 'player_queues/play' for c, _ in self.bridge.calls))

    def test_identity_race(self):
        self.bridge.statuses = [{'ready': True, 'playerId': 'local'}, {'ready': True, 'playerId': 'other'}]
        with self.assertRaises(m.Unavailable): self.adapter.action('Play')
        self.assertFalse(any(c == 'player_queues/play' for c, _ in self.bridge.calls))

    def test_queue_mismatch(self):
        self.bridge.queue['queue_id'] = 'remote'
        with self.assertRaises(m.Unavailable): self.adapter.action('Play')

    def test_queue_race(self):
        original = self.bridge.request
        count = 0
        def request(command, args):
            nonlocal count
            if command == 'player_queues/get_active_queue':
                count += 1
                if count == 2: self.bridge.queue['queue_id'] = 'remote'
            return original(command, args)
        self.bridge.request = request
        with self.assertRaises(m.Unavailable): self.adapter.action('Play')

    def test_group_membership_rejected_in_actions_and_snapshots(self):
        for field in ('group_members', 'group_childs', 'static_group_members', 'synced_to', 'active_group'):
            self.bridge.player[field] = ['remote'] if 'members' in field or field == 'group_childs' else 'remote'
            with self.assertRaises(m.Unavailable): self.adapter.action('Play')
            with self.assertRaises(m.Unavailable): self.adapter.snapshot()
            del self.bridge.player[field]
        self.assertFalse(any(c == 'player_queues/play' for c, _ in self.bridge.calls))

    def test_local_only_group_and_capability_allowed(self):
        self.bridge.player.update(group_members=['local'], group_childs=[], static_group_members=[],
                                  synced_to=None, active_group=None, can_group_with=['remote'])
        self.adapter.action('Play')
        self.adapter.snapshot()

    def test_new_group_between_resolutions(self):
        original = self.bridge.request
        count = 0
        def request(command, args):
            nonlocal count
            if command == 'players/get':
                count += 1
                if count == 2: self.bridge.player['group_members'] = ['remote']
            return original(command, args)
        self.bridge.request = request
        with self.assertRaises(m.Unavailable): self.adapter.action('Play')
        self.assertFalse(any(c == 'player_queues/play' for c, _ in self.bridge.calls))

    def test_pause_capability_survives_paused_and_idle(self):
        for state in ('playing', 'paused', 'idle'):
            self.bridge.queue['state'] = state
            self.assertTrue(self.adapter.snapshot()[1]['CanPause'])

    def test_actual_volume_and_clamped_local_write(self):
        self.assertEqual(self.adapter.snapshot()[1]['Volume'], .42)
        for value, expected in ((.37, 37), (-1, 0), (2, 100)):
            self.adapter.action('Volume', 'local', value)
            self.assertEqual(self.bridge.calls[-1], ('players/cmd/volume_set',
                                                   {'player_id': 'local', 'volume_level': expected}))

    def test_volume_invalid_and_nonlocal_errors(self):
        for value in (True, '0.5', None, float('nan'), float('inf')):
            with self.assertRaises(m.Unsupported): self.adapter.action('Volume', 'local', value)
        for field, value in (('volume_control', 'fake'), ('supported_features', [])):
            previous = self.bridge.player[field]
            self.bridge.player[field] = value
            with self.assertRaises(m.Unsupported): self.adapter.action('Volume', 'local', .5)
            self.bridge.player[field] = previous
        with self.assertRaises(m.Unavailable): self.adapter.action('Volume', 'old', .5)
        self.bridge.player['group_members'] = ['remote']
        with self.assertRaises(m.Unavailable): self.adapter.action('Volume', 'local', .5)
        self.assertFalse(any(c == 'players/cmd/volume_set' for c, _ in self.bridge.calls))

    def test_volume_rechecks_group_and_native_control(self):
        for field, value, error in (('group_members', ['remote'], m.Unavailable),
                                    ('volume_control', 'fake', m.Unsupported)):
            self.setUp()
            original = self.bridge.request
            count = 0
            def request(command, args):
                nonlocal count
                if command == 'players/get':
                    count += 1
                    if count == 2: self.bridge.player[field] = value
                return original(command, args)
            self.bridge.request = request
            with self.assertRaises(error): self.adapter.action('Volume', 'local', .5)
            self.assertFalse(any(c == 'players/cmd/volume_set' for c, _ in self.bridge.calls))

    def test_worker_volume_generation_gate_and_payload(self):
        class End(BaseException): pass
        for generation, expected in ((6, False), (7, True)):
            self.setUp()
            results = []
            worker = m.Worker(self.adapter, lambda fn, *args: fn(*args), lambda *args: None)
            worker.generation, worker.identity = 7, 'local'
            self.assertTrue(worker.submit('Volume', generation, 'local', results.append, .25))
            with patch.object(self.adapter, 'snapshot', side_effect=End):
                with self.assertRaises(End): worker.run()
            self.assertEqual(results, [expected])
            writes = [args for c, args in self.bridge.calls if c == 'players/cmd/volume_set']
            self.assertEqual(writes, [{'player_id': 'local', 'volume_level': 25}] if expected else [])

    def test_volume_missing_not_faked(self):
        self.bridge.player['volume_level'] = None
        with self.assertRaises(m.Unavailable): self.adapter.snapshot()

    def test_seek_discontinuity_without_tick_or_transition_noise(self):
        def props(pos, state='Playing', track='a'):
            return {'Position': pos * 1000000, 'PlaybackStatus': state,
                    'Metadata': {'mpris:trackid': track}, 'Rate': 1.0}
        detect = m.position_discontinuity
        self.assertFalse(detect(props(10), props(11), 1))
        self.assertFalse(detect(props(10), props(15), 5))
        self.assertTrue(detect(props(10), props(30), 1))
        self.assertTrue(detect(props(30), props(10), 1))
        self.assertTrue(detect(props(10, 'Paused'), props(30, 'Paused'), 1))
        self.assertFalse(detect(props(10), props(0, track='b'), 1))
        self.assertFalse(detect(props(10), props(0, 'Stopped'), 1))
        self.assertFalse(detect(props(0, 'Stopped'), props(30), 1))
        self.assertFalse(detect({}, props(30), 1))

    def test_metadata(self):
        _, props = self.adapter.snapshot()
        meta = props['Metadata']
        self.assertEqual(meta['xesam:title'], 'Song')
        self.assertEqual(meta['xesam:artist'], ['Artist'])
        self.assertEqual(meta['xesam:album'], 'Album')
        self.assertEqual(meta['mpris:length'], 30000000)
        self.assertRegex(meta['mpris:trackid'], r'^/org/mpris/MediaPlayer2/track/[a-f0-9]+$')
        self.assertEqual(props['PlaybackStatus'], 'Playing')
        self.assertFalse(props['CanSeek'])

    def test_metadata_validation_and_bounds(self):
        for value in [-1, float('nan'), float('inf'), 'bad', True, {}, 1e100]:
            result = m.micros(value)
            self.assertIsInstance(result, int)
            self.assertGreaterEqual(result, 0)
            self.assertLessEqual(result, 2**63-1)
        self.assertEqual(m.metadata({'current_item': None}), {})
        self.assertEqual(m.metadata({'current_item': {'media_item': {'name': [], 'artists': [None, {}, {'name': 1}]}}}), {})

    def test_idle_pause_not_faked(self):
        self.bridge.queue.update(state='idle', resume_pos=12)
        self.assertEqual(self.adapter.snapshot()[1]['PlaybackStatus'], 'Stopped')

    def test_unsupported(self):
        with self.assertRaises(m.Unsupported): self.adapter.action('OpenUri')
        self.assertEqual(self.bridge.calls, [])

    def test_empty_queue_cannot_resume(self):
        self.bridge.queue.update(current_item=None, items=0, current_index=None, state='idle')
        props = self.adapter.snapshot()[1]
        self.assertFalse(props['CanPlay'])
        self.assertFalse(props['CanPause'])
        self.assertFalse(props['CanGoNext'])
        self.assertFalse(props['CanGoPrevious'])

    def test_bounded_action_queue(self):
        worker = m.Worker(self.adapter, lambda *args: None, lambda *args: None)
        for _ in range(m.MAX_ACTIONS):
            self.assertTrue(worker.submit('Play', 1, 'local', lambda _: None))
        self.assertFalse(worker.submit('Play', 1, 'local', lambda _: None))

    def test_second_resolution_identity_race(self):
        self.bridge.statuses = [{'ready': True, 'playerId': 'local'}] * 2 + [
            {'ready': True, 'playerId': 'other'}]
        with self.assertRaises(m.Unavailable): self.adapter.action('Play')
        self.assertFalse(any(c == 'player_queues/play' for c, _ in self.bridge.calls))

    def test_expected_identity_rejects_old_action(self):
        with self.assertRaises(m.Unavailable): self.adapter.action('Play', 'old')
        self.assertFalse(any(c == 'player_queues/play' for c, _ in self.bridge.calls))

    def test_subprocess_timeout_and_sanitized_error(self):
        import subprocess
        with patch.object(m.subprocess, 'run', side_effect=subprocess.TimeoutExpired('secret', 1)):
            with self.assertRaisesRegex(m.Unavailable, '^Local player unavailable$'):
                m.CliBridge('/fake').status()


if __name__ == '__main__':
    unittest.main()
