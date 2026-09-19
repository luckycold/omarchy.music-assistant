#!/usr/bin/env python3
"""MPRIS for the private local bridge, never the plugin's selected player.

No credentials/config are read. DBus/GLib imports are deliberately executable-only.
All bridge I/O is serialized on one worker; GLib only serves cached properties.
"""
import hashlib
import json
import math
from pathlib import Path
import queue
import subprocess
import threading
import time

ROOT = 'org.mpris.MediaPlayer2'
PLAYER = ROOT + '.Player'
PROPERTIES = 'org.freedesktop.DBus.Properties'
BUS_NAME = ROOT + '.MusicAssistant'
OBJECT_PATH = '/org/mpris/MediaPlayer2'
COMMANDS = {name: 'player_queues/' + command for name, command in (
    ('Play', 'play'), ('Pause', 'pause'), ('PlayPause', 'play_pause'),
    ('Stop', 'stop'), ('Next', 'next'), ('Previous', 'previous'))}
MAX_ACTIONS = 8


class Unavailable(Exception):
    def __init__(self):
        super().__init__('Local player unavailable')


class Unsupported(Exception):
    pass


class CliBridge:
    def __init__(self, executable=None):
        self.executable = str(executable or Path.home() / '.local/bin/omarchy-ma-player')

    def call(self, mode, payload=None):
        try:
            result = subprocess.run([self.executable, mode],
                                    input=json.dumps(payload) + '\n' if payload else '',
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    timeout=5, check=False)
            if result.returncode or len(result.stdout) > 8 * 1024 * 1024:
                raise Unavailable()
            data = json.loads(result.stdout)
            if not isinstance(data, dict) or data.get('error'):
                raise Unavailable()
            return data if mode == 'status' else data['result']
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
            raise Unavailable() from None

    def status(self):
        return self.call('status')

    def request(self, command, args):
        return self.call('request', {'command': command, 'args': args})


def micros(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    try:
        if not math.isfinite(value) or value <= 0:
            return 0
        return min(int(value * 1000000), 2**63 - 1)
    except (ValueError, OverflowError):
        return 0


def text(value):
    return value[:4096] if isinstance(value, str) else ''


def metadata(q):
    item = q.get('current_item')
    if not isinstance(item, dict):
        return {}
    media = item.get('media_item')
    media = media if isinstance(media, dict) else {}
    result = {}
    ident = item.get('queue_item_id') or item.get('id')
    if isinstance(ident, (str, int)) and not isinstance(ident, bool):
        digest = hashlib.sha256((str(q.get('queue_id', '')) + '\0' + str(ident)).encode()).hexdigest()
        result['mpris:trackid'] = OBJECT_PATH + '/track/' + digest
    title = text(media.get('name')) or text(item.get('name'))
    if title:
        result['xesam:title'] = title
    artists = media.get('artists')
    if isinstance(artists, list):
        names = [text(a.get('name')) for a in artists[:100] if isinstance(a, dict)]
        if any(names):
            result['xesam:artist'] = [name for name in names if name]
    album = media.get('album')
    if isinstance(album, dict) and text(album.get('name')):
        result['xesam:album'] = text(album['name'])
    duration = micros(item.get('duration', media.get('duration')))
    if duration:
        result['mpris:length'] = duration
    return result


def normalized_volume(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Unsupported()
    try:
        if not math.isfinite(value):
            raise Unsupported()
    except OverflowError:
        raise Unsupported() from None
    return float(max(0, min(1, value)))


def position_discontinuity(previous, current, elapsed):
    track = previous.get('Metadata', {}).get('mpris:trackid')
    state = previous.get('PlaybackStatus')
    if (not track or track != current.get('Metadata', {}).get('mpris:trackid')
            or state not in ('Playing', 'Paused') or state != current.get('PlaybackStatus')):
        return False
    expected = previous['Position']
    if state == 'Playing':
        expected += max(0, elapsed) * 1000000 * previous.get('Rate', 1.0)
    # MA whole-second timestamps and polling introduce normal jitter.
    return abs(current['Position'] - expected) > 2000000


class Adapter:
    def __init__(self, bridge):
        self.bridge = bridge

    def identity(self):
        status = self.bridge.status()
        if not isinstance(status, dict) or status.get('ready') is not True:
            raise Unavailable()
        ident = status.get('playerId')
        if not isinstance(ident, str) or not ident or len(ident) > 1024:
            raise Unavailable()
        return ident

    def resolve(self):
        ident = self.identity()
        player = self.bridge.request('players/get', {'player_id': ident})
        if not isinstance(player, dict) or player.get('player_id') != ident or player.get('available') is not True:
            raise Unavailable()
        for field in ('group_members', 'group_childs', 'static_group_members'):
            members = player.get(field, [])
            if not isinstance(members, list) or any(member != ident for member in members):
                raise Unavailable()
        for field in ('synced_to', 'active_group'):
            if player.get(field) not in (None, '', ident):
                raise Unavailable()
        q = self.bridge.request('player_queues/get_active_queue', {'player_id': ident})
        # A group redirected to another device is not personal local playback.
        if not isinstance(q, dict) or q.get('queue_id') != ident:
            raise Unavailable()
        if self.identity() != ident:
            raise Unavailable()
        return ident, q, player

    def snapshot(self):
        ident, q, player = self.resolve()
        try:
            raw_volume = player.get('volume_level')
            if isinstance(raw_volume, bool) or not isinstance(raw_volume, (int, float)):
                raise Unsupported()
            normalized_volume(raw_volume)
            volume = normalized_volume(raw_volume / 100)
        except Unsupported:
            raise Unavailable() from None
        state = {'playing': 'Playing', 'paused': 'Paused'}.get(q.get('state'), 'Stopped')
        count = q.get('items')
        count = count if isinstance(count, int) and not isinstance(count, bool) and count > 0 else 0
        index = q.get('current_index')
        index = index if isinstance(index, int) and not isinstance(index, bool) and index >= 0 else None
        playable = bool(q.get('current_item')) or count > 0
        return ident, {'PlaybackStatus': state, 'Metadata': metadata(q),
                       'Position': micros(q.get('elapsed_time')), 'Rate': 1.0,
                       'MinimumRate': 1.0, 'MaximumRate': 1.0, 'Volume': volume,
                       'CanControl': True, 'CanPlay': playable,
                       'CanPause': playable, 'CanSeek': False,
                       'CanGoNext': bool(q.get('next_item')) or (index is not None and index + 1 < count),
                       'CanGoPrevious': index is not None and index > 0}

    def action(self, method, expected_identity=None, value=None):
        if method not in COMMANDS and method != 'Volume':
            raise Unsupported()
        if method == 'Volume':
            value = normalized_volume(value)
        ident, first, _ = self.resolve()
        if expected_identity is not None and ident != expected_identity:
            raise Unavailable()
        # Re-resolve availability and queue immediately before a mutation. The
        # API has no atomic compare-and-act, so never follow a changed identity.
        second_ident, second, player = self.resolve()
        if second_ident != ident or first['queue_id'] != second['queue_id']:
            raise Unavailable()
        if method == 'Volume':
            if (player.get('volume_control') != 'native'
                    or 'volume_set' not in (player.get('supported_features') or [])):
                raise Unsupported()
            self.bridge.request('players/cmd/volume_set',
                                {'player_id': ident, 'volume_level': round(value * 100)})
        else:
            self.bridge.request(COMMANDS[method], {'queue_id': ident})


class Worker:
    """One bounded action queue; polls cannot overlap actions or other polls."""
    def __init__(self, adapter, dispatch, publish):
        self.adapter, self.dispatch, self.publish = adapter, dispatch, publish
        self.actions = queue.Queue(maxsize=MAX_ACTIONS)
        self.generation = 0
        self.identity = None
        self.thread = threading.Thread(target=self.run, daemon=True)

    def submit(self, method, generation, ident, callback, value=None):
        try:
            self.actions.put_nowait((method, generation, ident, callback, value))
            return True
        except queue.Full:
            return False

    def run(self):
        while True:
            task = None
            try:
                task = self.actions.get(timeout=1)
            except queue.Empty:
                pass
            if task:
                method, generation, ident, callback, value = task
                ok = False
                try:
                    if generation != self.generation or not ident or ident != self.identity:
                        raise Unavailable()
                    self.adapter.action(method, ident, value)
                    ok = True
                except Exception:
                    # Never expose bridge exception payloads, identifiers or URLs.
                    self.identity = None
                    self.generation += 1
                self.dispatch(callback, ok)
            try:
                ident, props = self.adapter.snapshot()
                if ident != self.identity:
                    self.generation += 1
                self.identity = ident
            except Exception:
                self.generation += 1
                self.identity, props = None, None
            self.dispatch(self.publish, self.generation, self.identity, props)


def main():
    import dbus
    import dbus.service
    from dbus.mainloop.glib import DBusGMainLoop
    from gi.repository import GLib

    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()

    def error(name='Failed'):
        return dbus.exceptions.DBusException('Local player unavailable' if name == 'Failed' else 'Not supported',
                                             name='org.freedesktop.DBus.Error.' + name)

    def typed(props):
        result = {}
        for key, value in props.items():
            if key == 'Metadata':
                meta = {}
                for mk, mv in value.items():
                    meta[mk] = (dbus.ObjectPath(mv) if mk == 'mpris:trackid' else
                                dbus.Int64(mv) if mk == 'mpris:length' else
                                dbus.Array(mv, signature='s') if isinstance(mv, list) else dbus.String(mv))
                result[key] = dbus.Dictionary(meta, signature='sv')
            elif isinstance(value, bool): result[key] = dbus.Boolean(value)
            elif key == 'Position': result[key] = dbus.Int64(value)
            elif isinstance(value, float): result[key] = dbus.Double(value)
            elif isinstance(value, list): result[key] = dbus.Array(value, signature='s')
            else: result[key] = dbus.String(value)
        return result

    class Service(dbus.service.Object):
        def __init__(self):
            super().__init__(bus, OBJECT_PATH)
            self.name = None
            self.generation = -1
            self.ident = None
            self.props = {}
            self.position_time = None
            self.root = typed({'CanQuit': False, 'CanRaise': False, 'HasTrackList': False,
                               'Identity': 'Music Assistant', 'DesktopEntry': 'music-assistant',
                               'SupportedUriSchemes': [], 'SupportedMimeTypes': []})

        def publish(self, generation, ident, props):
            # The worker can invalidate a generation before GLib consumes its
            # pending idle callback. Never resurrect that stale player snapshot.
            if generation < self.generation or generation != worker.generation:
                return False
            same_identity = self.ident == ident and self.generation == generation
            self.generation, self.ident = generation, ident
            if props is None:
                self.props = {}
                self.position_time = None
                if self.name is not None:
                    bus.release_name(BUS_NAME)
                    self.name = None
                return False
            values = typed(props)
            now = time.monotonic()
            seeked = (same_identity and self.position_time is not None
                      and position_discontinuity(self.props, props, now - self.position_time))
            self.position_time = now
            # MPRIS Position is read-only and does not emit PropertiesChanged;
            # avoid treating elapsed-time ticks as fresh media-source activity.
            changed = {k: v for k, v in values.items()
                       if k != 'Position' and self.props.get(k) != v}
            self.props = values
            if self.name is None:
                try:
                    self.name = dbus.service.BusName(BUS_NAME, bus=bus, do_not_queue=True)
                except dbus.exceptions.DBusException:
                    return False
            if changed:
                self.PropertiesChanged(PLAYER, changed, [])
            if seeked:
                self.Seeked(dbus.Int64(props['Position']))
            return False

        @dbus.service.method(PROPERTIES, in_signature='s', out_signature='a{sv}')
        def GetAll(self, interface):
            if interface == ROOT: return self.root
            if interface == PLAYER: return self.props
            raise error('UnknownInterface')

        @dbus.service.method(PROPERTIES, in_signature='ss', out_signature='v')
        def Get(self, interface, prop):
            values = self.GetAll(interface)
            if prop not in values: raise error('UnknownProperty')
            return values[prop]

        @dbus.service.method(PROPERTIES, in_signature='ssv', async_callbacks=('reply', 'fail'))
        def Set(self, interface, prop, value, reply, fail):
            if interface == PLAYER and prop == 'Rate' and value == 1.0:
                reply()
                return
            if interface == PLAYER and prop == 'Volume':
                try:
                    if isinstance(value, dbus.Boolean):
                        raise Unsupported()
                    value = normalized_volume(value)
                except Unsupported:
                    fail(error('InvalidArgs'))
                    return
                self.invoke('Volume', reply, fail, value)
                return
            fail(error('NotSupported'))

        @dbus.service.signal(PLAYER, signature='x')
        def Seeked(self, position):
            pass

        @dbus.service.signal(PROPERTIES, signature='sa{sv}as')
        def PropertiesChanged(self, interface, changed, invalidated):
            pass

        def invoke(self, method, reply, fail, value=None):
            def complete(ok):
                if ok: reply()
                else: fail(error())
                return False
            if not self.ident or not worker.submit(method, self.generation, self.ident, complete, value):
                fail(error())

        @dbus.service.method(PLAYER, async_callbacks=('reply', 'fail'))
        def Play(self, reply, fail): self.invoke('Play', reply, fail)

        @dbus.service.method(PLAYER, async_callbacks=('reply', 'fail'))
        def Pause(self, reply, fail): self.invoke('Pause', reply, fail)

        @dbus.service.method(PLAYER, async_callbacks=('reply', 'fail'))
        def PlayPause(self, reply, fail): self.invoke('PlayPause', reply, fail)

        @dbus.service.method(PLAYER, async_callbacks=('reply', 'fail'))
        def Stop(self, reply, fail): self.invoke('Stop', reply, fail)

        @dbus.service.method(PLAYER, async_callbacks=('reply', 'fail'))
        def Next(self, reply, fail): self.invoke('Next', reply, fail)

        @dbus.service.method(PLAYER, async_callbacks=('reply', 'fail'))
        def Previous(self, reply, fail): self.invoke('Previous', reply, fail)

        @dbus.service.method(PLAYER, in_signature='x')
        def Seek(self, offset): raise error('NotSupported')

        @dbus.service.method(PLAYER, in_signature='ox')
        def SetPosition(self, track_id, position): raise error('NotSupported')

        @dbus.service.method(PLAYER, in_signature='s')
        def OpenUri(self, uri): raise error('NotSupported')

        @dbus.service.method(ROOT)
        def Raise(self): raise error('NotSupported')

        @dbus.service.method(ROOT)
        def Quit(self): raise error('NotSupported')

    service = Service()
    worker = Worker(Adapter(CliBridge()), GLib.idle_add, service.publish)
    worker.thread.start()
    GLib.MainLoop().run()


if __name__ == '__main__':
    main()
