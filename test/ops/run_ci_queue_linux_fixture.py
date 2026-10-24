#!/usr/bin/env python3
"""Bounded Linux replay of the real shared CI hook in isolated transient units.

Only ROOT/RUNNERS/HOOK are replaced in the source fixture. No production unit,
runner configuration, group membership or installed queue file is changed.
"""
from __future__ import annotations

import argparse
import ctypes
import fcntl
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import signal
import stat
import subprocess
import sys
import time
import traceback


FIXTURE_PARENT = Path('/var/lib')


def hook_command(path):
    # Runner selects the hook interpreter by extension before starting the
    # script. Directly exec'ing an extensionless shebang would miss that gate.
    if Path(path).suffix != '.sh':
        raise RuntimeError('Fixture requires the runner-supported .sh hook extension')
    return ['/usr/bin/bash', '-e', str(path)]


def reviewed_hook_path(source):
    match = re.search(r"^HOOK = Path\('([^'\n]+)'\)$", source.decode(), re.MULTILINE)
    if match is None:
        raise RuntimeError('Cannot establish reviewed hook path')
    path = Path(match.group(1))
    hook_command(path)
    return path


def validate_base(base, fresh=False):
    """Confine destructive cleanup to the root-created, non-symlink fixture dir."""
    if (not base.is_absolute() or base.parent != FIXTURE_PARENT
            or not re.fullmatch(r'ciq-fixture-[A-Za-z0-9]+', base.name)
            or base.is_symlink() or base.resolve() != base):
        raise RuntimeError('Unsafe fixture directory')
    info = base.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('Fixture directory must be root-owned and not writable by others')
    if fresh:
        expected = {'run-fixtures.py', 'shared-ci-queue.source.py'}
        if {p.name for p in base.iterdir()} != expected:
            raise RuntimeError('Fixture directory is not a fresh staged replay')
        for path in base.iterdir():
            item = path.lstat()
            if not stat.S_ISREG(item.st_mode) or item.st_uid != 0 or item.st_mode & 0o022:
                raise RuntimeError('Unsafe staged fixture file')


def atomic(path, value):
    temporary = path.with_suffix('.temporary')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def event(directory, identity, phase, **extra):
    path = directory / (identity + '.event.json')
    previous = json.loads(path.read_text()) if path.exists() else {}
    previous.update(extra)
    previous.update(phase=phase, at=time.monotonic())
    atomic(path, previous)


def orphan(config):
    libc = ctypes.CDLL(None)
    libc.prctl(15, b'ciq-orphan', 0, 0, 0)
    if config.get('undumpable'):
        assert libc.prctl(4, 0, 0, 0, 0) == 0
    Path(config['ready']).write_text(str(os.getpid()))
    time.sleep(90)


def worker(config):
    assert ctypes.CDLL(None).prctl(15, b'Runner.Worker', 0, 0, 0) == 0
    directory, identity = Path(config['directory']), config['id']
    event(directory, identity, 'worker-start', pid=os.getpid())
    hook = None
    def cancel(_signum, _frame):
        # Model Runner.Worker's ordinary cancellation cleanup of its hook.
        if hook and hook.poll() is None:
            hook.terminate()
            try:
                hook.wait(timeout=3)
            except subprocess.TimeoutExpired:
                hook.kill()
                hook.wait(timeout=3)
        event(directory, identity, 'cancelled')
        raise SystemExit(143)
    signal.signal(signal.SIGTERM, cancel)
    with (directory / (identity + '.hook.log')).open('w') as log:
        hook = subprocess.Popen(hook_command(config['hook']), stdout=log, stderr=log)
        event(directory, identity, 'hook-waiting', hook_pid=hook.pid)
        code = hook.wait(timeout=70)
    event(directory, identity, 'hook-return', hook_code=code)
    if code:
        return code
    event(directory, identity, 'payload', payload_start=time.monotonic())
    if config.get('orphan'):
        ready = directory / (identity + '.orphan.pid')
        data = json.dumps({'ready': str(ready), 'undumpable': config.get('undumpable', False)})
        child = subprocess.Popen([sys.executable, __file__, '--orphan', data])
        event(directory, identity, 'payload', orphan_pid=child.pid)
    deadline = time.monotonic() + 65
    while not (directory / (identity + '.finish')).exists():
        if time.monotonic() > deadline:
            raise RuntimeError('Fixture payload deadline exceeded')
        time.sleep(.05)
    event(directory, identity, 'done', payload_end=time.monotonic())
    return 0


def supervisor(config):
    directory = Path(config['directory'])
    seen, children = set(), []
    while True:
        for command in directory.glob('*.command.json'):
            if command.name in seen:
                continue
            seen.add(command.name)
            item = json.loads(command.read_text())
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                   'SHARED_CI_QUEUE_UNIT': config['unit'],
                   'GITHUB_REPOSITORY': config['repository'],
                   'GITHUB_WORKFLOW': item.get('workflow', 'Fixture heavy'),
                   'GITHUB_JOB': item.get('job', 'checks'),
                   'RUNNER_TRACKING_ID': config['prefix'] + '-' + item['id']}
            item.update(directory=str(directory), hook=config['hook'])
            children.append(subprocess.Popen([sys.executable, __file__, '--worker', json.dumps(item)], env=env))
        for child in children:
            child.poll()  # Reap dead Workers; do not auto-kill orphan payloads.
        time.sleep(.05)


class Replay:
    def __init__(self, base, source):
        validate_base(base, fresh=True)
        self.base = base
        self.source = source
        self.prefix = base.name
        if not re.fullmatch(r'ciq-fixture-[A-Za-z0-9]+', self.prefix):
            raise RuntimeError('Unsafe fixture prefix')
        self.group = self.prefix
        self.units = {letter: self.prefix + '-' + letter + '.service' for letter in 'abc'}
        self.identities = {'a': ('valci', 'valbarko/gde-moi-klienty'),
                           'b': ('telo-ci', 'valbarko/telovporiadke'),
                           'c': ('valci', 'valbarko/vbclub-training')}
        self.root = base / 'state'
        self.library = base / 'shared-ci-queue.py'
        self.hook = base / 'hook.sh'
        self.evidence = {'source_sha256': hashlib.sha256(source).hexdigest(), 'prefix': self.prefix,
                         'started_at': time.time(), 'limits': {'global_seconds': 240, 'step_seconds': 15,
                         'cpu_quota_per_fixture': '10%', 'memory_max_per_fixture': '96M'},
                         'tests': [], 'recover_operations': []}
        self.created_units = []
        self.group_created = False
        self.group_gid = None
        self.deadline = time.monotonic() + 230

    def command(self, *args, check=True):
        result = subprocess.run(args, text=True, capture_output=True, timeout=12)
        if check and result.returncode:
            raise RuntimeError(f'Command failed: {args!r}: {result.stderr}')
        return result

    def wait(self, predicate, description, timeout=15):
        until = min(time.monotonic() + timeout, self.deadline)
        while time.monotonic() < until:
            value = predicate()
            if value:
                return value
            time.sleep(.05)
        raise AssertionError('Deadline: ' + description)

    def check(self, name, **details):
        self.evidence['tests'].append({'name': name, 'passed': True, **details})
        print('PASS ' + name, flush=True)

    def directory(self, letter):
        return self.root / self.units[letter]

    def read_event(self, letter, identity):
        path = self.directory(letter) / (identity + '.event.json')
        try:
            return json.loads(path.read_text())
        except FileNotFoundError:
            return {}

    def state(self, letter):
        path = self.directory(letter) / 'state.json'
        return json.loads(path.read_text()) if path.exists() else None

    def start(self, letter, identity, **options):
        atomic(self.directory(letter) / (identity + '.command.json'), {'id': identity, **options})
        return self.wait(lambda: self.read_event(letter, identity).get('pid'), identity + ' Worker start')

    def payload(self, letter, identity):
        return self.wait(lambda: (value if (value := self.read_event(letter, identity)).get('payload_start') else None),
                         identity + ' payload start')

    def finish(self, letter, identity):
        (self.directory(letter) / (identity + '.finish')).touch()
        return self.wait(lambda: (value if (value := self.read_event(letter, identity)).get('payload_end') else None),
                         identity + ' payload finish')

    def released(self, letter):
        return self.wait(lambda: (value if (value := self.state(letter)) and value['status'] == 'released' else None),
                         letter + ' lease release')

    def incident(self, letter):
        return self.wait(lambda: (value if (value := self.state(letter)) and value['status'] == 'incident' else None),
                         letter + ' incident latch')

    def rejected(self, letter, identity):
        value = self.wait(lambda: (value if (value := self.read_event(letter, identity)).get('hook_code', 0) != 0 else None),
                          identity + ' hook rejection')
        assert not value.get('payload_start')
        log = (self.directory(letter) / (identity + '.hook.log')).read_text()
        assert 'Unreleased CI lease' in log, log
        return {'hook_code': value['hook_code'], 'reason': 'Unreleased CI lease'}

    def keeper(self, letter):
        group = Path('/sys/fs/cgroup/system.slice/system-valci.slice') / self.units[letter]
        def find():
            for pid in group.joinpath('cgroup.procs').read_text().split():
                try:
                    command = Path('/proc', pid, 'cmdline').read_bytes().split(b'\0')
                    if str(self.library).encode() in command and b'keep' in command:
                        return int(pid)
                except FileNotFoundError:
                    pass
        return self.wait(find, letter + ' keeper')

    def process_identity(self, pid):
        try:
            directory = Path('/proc', str(pid))
            fields = directory.joinpath('stat').read_text().rsplit(')', 1)[1].split()
            group = next(line[3:] for line in directory.joinpath('cgroup').read_text().splitlines()
                         if line.startswith('0::'))
            return {'start': int(fields[19]), 'group': group}
        except (FileNotFoundError, ProcessLookupError):
            return None

    def signal(self, pid, sig=signal.SIGKILL):
        before = self.process_identity(pid)
        if before is None:
            return
        groups = {'/system.slice/system-valci.slice/' + unit: unit for unit in self.units.values()}
        if before['group'] not in groups:
            raise RuntimeError('Refusing signal outside fixture cgroups')
        if self.owned_unit(groups[before['group']]) is None:
            raise RuntimeError('Fixture unit disappeared before signal')
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            return
        try:
            if self.process_identity(pid) != before:
                raise RuntimeError('Fixture process identity changed before signal')
            try:
                signal.pidfd_send_signal(fd, sig)
            except ProcessLookupError:
                pass
        finally:
            os.close(fd)

    def description(self, unit):
        return 'Shared CI queue fixture ' + unit + ' at ' + str(self.base)

    def unit_properties(self, unit):
        if unit not in self.units.values():
            raise RuntimeError('Refusing non-fixture unit')
        result = self.command('systemctl', 'show', unit, '-p', 'LoadState', '-p', 'ActiveState',
                              '-p', 'Transient', '-p', 'Description', '-p', 'User', '-p', 'Slice', check=False)
        props = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        if 'LoadState' not in props:
            raise RuntimeError('Cannot establish fixture unit identity')
        return props

    def owned_unit(self, unit):
        props = self.unit_properties(unit)
        if props['LoadState'] == 'not-found':
            return None
        letter = next(key for key, name in self.units.items() if name == unit)
        if (props.get('Transient') != 'yes' or props.get('Description') != self.description(unit)
                or props.get('User') != self.identities[letter][0] or props.get('Slice') != 'system-valci.slice'):
            raise RuntimeError('Fixture unit identity mismatch; preserve unit: ' + unit)
        return props

    def launch(self, unit, *args):
        if self.unit_properties(unit)['LoadState'] != 'not-found':
            raise RuntimeError('Fixture unit already exists; preserve it: ' + unit)
        # An indeterminate systemd-run result can still have created the unit.
        self.created_units.append(unit)
        self.command(*args)

    def recover(self, letter, should_fail=False):
        unit = self.units[letter]
        assert unit in self.queue.RUNNERS
        try:
            result = self.queue.recover(unit)
        except RuntimeError as error:
            if not should_fail:
                raise
            assert 'Worker or tracked descendants still exist' in str(error), str(error)
            result = {'refused': str(error)}
        else:
            assert not should_fail, result
        frozen = self.command('systemctl', 'show', unit, '-p', 'FreezerState', '--value').stdout.strip()
        assert frozen == 'running', frozen
        return result

    def setup(self):
        assert os.geteuid() == 0 and os.uname().nodename == 'gmk-prod-1'
        assert hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal')
        original_hook = reviewed_hook_path(self.source)
        self.base.chmod(0o755)
        try:
            grp.getgrnam(self.group)
        except KeyError:
            pass
        else:
            raise RuntimeError('Fixture group already exists; preserve it')
        # Record intent before a command whose result may be indeterminate.
        self.group_created = True
        try:
            self.command('groupadd', '--system', self.group)
        finally:
            try:
                self.group_gid = grp.getgrnam(self.group).gr_gid
            except KeyError:
                pass
        gid = self.group_gid
        self.root.mkdir(mode=0o755)
        lock = self.root / 'slot.lock'
        lock.touch(mode=0o640)
        os.chown(lock, 0, gid)
        os.chmod(lock, 0o640)
        info = lock.stat()
        assert info.st_uid == 0 and info.st_gid == gid and info.st_mode & 0o777 == 0o640
        fixture = self.source.decode()
        fixture = fixture.replace("ROOT = Path('/run/shared-ci-queue')", f'ROOT = Path({str(self.root)!r})', 1)
        original_assignment = 'HOOK = Path(' + repr(str(original_hook)) + ')'
        assert fixture.count(original_assignment) == 1
        fixture = fixture.replace(original_assignment, f'HOOK = Path({str(self.hook)!r})', 1)
        runners = {self.units[key]: self.identities[key] for key in 'abc'}
        fixture, count = re.subn(r'(?ms)^RUNNERS = \{.*?^\}', 'RUNNERS = ' + repr(runners), fixture, count=1)
        assert count == 1
        self.library.write_text(fixture)
        self.library.chmod(0o755)
        self.hook.write_text('#!/bin/sh\nexec /usr/bin/python3 ' + shlex.quote(str(self.library)) + ' hook\n')
        self.hook.chmod(0o755)
        spec = importlib.util.spec_from_file_location('fixture_queue', self.library)
        self.queue = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.queue)
        actual_budget = self.queue.budget_module()
        replay = self
        class SpyBudget:
            def properties(self, unit):
                assert unit in replay.units.values()
                return actual_budget.properties(unit)
            def run(self, *args):
                assert len(args) == 3 and args[0] == 'systemctl' and args[1] in {'freeze', 'thaw'} and args[2] in replay.units.values(), args
                result = actual_budget.run(*args)
                observed = replay.command('systemctl', 'show', args[2], '-p', 'FreezerState', '--value').stdout.strip()
                replay.evidence['recover_operations'].append({'action': args[1], 'unit': args[2], 'observed': observed})
                assert observed == ('frozen' if args[1] == 'freeze' else 'running')
                return result
        self.queue.budget_module = lambda: SpyBudget()
        for letter, unit in self.units.items():
            user, repository = self.identities[letter]
            directory = self.directory(letter)
            directory.mkdir()
            os.chown(directory, pwd.getpwnam(user).pw_uid, gid)
            directory.chmod(0o2750)
            config = self.base / (letter + '.supervisor.json')
            config.write_text(json.dumps({'directory': str(directory), 'unit': unit, 'repository': repository,
                                         'prefix': self.prefix, 'hook': str(self.hook)}))
            self.launch(unit, 'systemd-run', '--quiet', '--collect', '--unit=' + unit,
                         '-p', 'Description=' + self.description(unit),
                         '-p', 'User=' + user, '-p', 'SupplementaryGroups=' + self.group,
                         '-p', 'Slice=system-valci.slice', '-p', 'CPUQuota=10%', '-p', 'MemoryMax=96M',
                         '-p', 'TasksMax=24', '-p', 'RuntimeMaxSec=240', '-p', 'TimeoutStopSec=3',
                         '-p', 'KillMode=control-group', '--', sys.executable, __file__, '--supervisor', str(config))
        self.check('isolated fixture setup: root lock 0640, setgid state dirs, two UIDs', units=self.units,
                   uid_valci=pwd.getpwnam('valci').pw_uid, uid_telo_ci=pwd.getpwnam('telo-ci').pw_uid,
                   reviewed_hook=str(original_hook), hook_interpreter=hook_command(self.hook)[:2])

    def tests(self):
        self.start('a', 'serial-a')
        first = self.payload('a', 'serial-a')
        keeper = self.keeper('a')
        values = Path('/proc', str(keeper), 'environ').read_bytes().split(b'\0')
        assert not any(value.startswith(b'RUNNER_TRACKING_ID=') for value in values)
        self.check('live independently execed keeper has no RUNNER_TRACKING_ID', keeper_pid=keeper)
        self.start('b', 'serial-b')
        self.wait(lambda: self.read_event('b', 'serial-b').get('hook_pid'), 'second hook waiting')
        time.sleep(.5)
        assert not self.read_event('b', 'serial-b').get('payload_start')
        self.start('c', 'light', workflow='CI', job='classify')
        light = self.payload('c', 'light')
        assert self.state('c') is None
        self.finish('c', 'light')
        ended = self.finish('a', 'serial-a')
        assert first['payload_start'] <= light['payload_start'] < ended['payload_end']
        self.released('a')
        second = self.payload('b', 'serial-b')
        assert second['payload_start'] >= ended['payload_end']
        self.finish('b', 'serial-b')
        self.released('b')
        self.check('two heavy jobs never overlap and lightweight classifier bypasses held slot',
                   first_start=first['payload_start'], first_end=ended['payload_end'],
                   second_start=second['payload_start'], light_start=light['payload_start'])

        self.start('a', 'cancel-holder')
        self.payload('a', 'cancel-holder')
        prior_b = self.state('b')
        waiting = self.start('b', 'cancel-waiter')
        self.wait(lambda: self.read_event('b', 'cancel-waiter').get('hook_pid'), 'cancellable hook wait')
        self.signal(waiting, signal.SIGTERM)
        self.wait(lambda: self.read_event('b', 'cancel-waiter').get('phase') == 'cancelled', 'normal cancellation cleanup')
        assert self.state('b') == prior_b
        assert self.state('a')['status'] == 'holding'
        self.finish('a', 'cancel-holder')
        self.released('a')
        self.start('c', 'after-cancel')
        self.payload('c', 'after-cancel')
        self.finish('c', 'after-cancel')
        self.released('c')
        self.check('normal waiting cancellation leaks neither holding state nor lock')

        victim = self.start('a', 'orphaned', orphan=True)
        orphan_event = self.payload('a', 'orphaned')
        orphan_pid = self.wait(lambda: self.read_event('a', 'orphaned').get('orphan_pid'), 'tracked orphan start')
        self.wait(lambda: (self.directory('a') / 'orphaned.orphan.pid').exists(), 'orphan ready')
        self.signal(victim)
        incident = self.incident('a')
        assert incident['phase'] == 'orphaned-payload', incident
        self.start('c', 'blocked-by-orphan')
        self.rejected('c', 'blocked-by-orphan')
        self.check('abrupt Worker SIGKILL plus tracked orphan creates fail-closed incident',
                   worker_pid=victim, orphan_pid=orphan_pid, phase=incident['phase'])
        self.signal(orphan_pid)
        self.wait(lambda: not self.queue.same_process(self.queue.read_process(orphan_pid) or {'pid': orphan_pid, 'start': -1}), 'orphan stops')
        time.sleep(.3)
        assert self.state('a')['status'] == 'incident'
        self.start('c', 'blocked-after-orphan-end')
        self.rejected('c', 'blocked-after-orphan-end')
        self.check('incident is not automatically cleared after orphan termination')
        recovered = self.recover('a')
        assert self.state('a')['phase'] == 'operator-verified'
        self.check('root recovery freezes safe fixture unit, verifies no payload, releases and thaws', result=recovered)

        old_worker = self.start('a', 'keeper-victim', orphan=True)
        self.payload('a', 'keeper-victim')
        orphan_pid = self.wait(lambda: self.read_event('a', 'keeper-victim').get('orphan_pid'), 'keeper victim orphan')
        self.wait(lambda: (self.directory('a') / 'keeper-victim.orphan.pid').exists(), 'keeper victim orphan ready')
        old_state = self.state('a')
        keeper = self.keeper('a')
        self.signal(keeper)
        self.start('c', 'blocked-by-dead-keeper')
        self.rejected('c', 'blocked-by-dead-keeper')
        self.start('a', 'same-unit-next-worker')
        self.rejected('a', 'same-unit-next-worker')
        assert self.state('a') == old_state
        self.check('killed keeper releases flock but latch blocks new heavy and same-unit Worker cannot overwrite old holding',
                   keeper_pid=keeper, old_worker_pid=old_worker)
        refused = self.recover('a', should_fail=True)
        assert self.state('a') == old_state
        self.check('frozen root recovery refuses live old Worker/orphan and always thaws', result=refused)
        self.signal(old_worker)
        self.signal(orphan_pid)
        self.wait(lambda: not self.queue.same_process(old_state['worker']), 'old Worker gone')
        time.sleep(.3)
        self.recover('a')

        victim = self.start('a', 'unreadable-orphan', orphan=True, undumpable=True)
        self.payload('a', 'unreadable-orphan')
        orphan_pid = self.wait(lambda: self.read_event('a', 'unreadable-orphan').get('orphan_pid'), 'undumpable orphan start')
        self.wait(lambda: (self.directory('a') / 'unreadable-orphan.orphan.pid').exists(), 'undumpable orphan ready')
        denied = False
        try:
            os.seteuid(pwd.getpwnam('valci').pw_uid)
            try:
                Path('/proc', str(orphan_pid), 'environ').read_bytes()
            except PermissionError:
                denied = True
        finally:
            os.seteuid(0)
        assert denied, 'Fixture must actually produce Linux PermissionError'
        self.signal(victim)
        incident = self.incident('a')
        assert incident['phase'] == 'keeper-failed', incident
        self.start('c', 'blocked-by-permission-error')
        self.rejected('c', 'blocked-by-permission-error')
        self.check('real /proc environ PermissionError fails closed with keeper-failed incident', orphan_pid=orphan_pid)
        self.signal(orphan_pid)
        time.sleep(.3)
        self.recover('a')

        self.start('b', 'last-heavy')
        self.payload('b', 'last-heavy')
        self.finish('b', 'last-heavy')
        self.released('b')
        for letter in 'abc':
            value = self.state(letter)
            assert value is None or value['status'] == 'released'
        fd = self.queue.open_lock()
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd)
        self.check('fresh heavy work resumes after verified recovery; all latches released and flock free')

    def cleanup(self):
        import shutil
        errors = []
        def attempt(label, operation, default=None):
            try:
                return operation()
            except BaseException as error:
                errors.append(label + ': ' + repr(error))
                return default

        # Evidence is best effort. Its failure must never bypass unit cleanup.
        self.evidence['worker_events'] = attempt('worker events', lambda: {
            str(p.relative_to(self.base)): json.loads(p.read_text())
            for p in self.root.glob('*/*.event.json')}, {})
        self.evidence['fixture_journals'] = {}
        for unit in self.created_units:
            self.evidence['fixture_journals'][unit] = attempt('journal ' + unit, lambda unit=unit:
                self.command('journalctl', '-u', unit, '-n', '50', '--no-pager', '-o', 'cat', check=False).stdout, '')
        for unit in reversed(self.created_units):
            # Intent was recorded before launch. Inspect the actual unit before
            # touching it, including when systemd-run timed out after creation.
            try:
                owned = self.owned_unit(unit)
            except BaseException as error:
                errors.append('unit ownership ' + unit + ': ' + repr(error))
                continue
            if owned is not None:
                attempt('stop ' + unit, lambda unit=unit: self.command('systemctl', 'stop', unit, check=False))
                attempt('reset ' + unit, lambda unit=unit: self.command('systemctl', 'reset-failed', unit, check=False))
        unsafe = []
        for unit in self.created_units:
            try:
                owned = self.owned_unit(unit)
                if owned and owned.get('ActiveState') not in {'inactive', 'failed'}:
                    unsafe.append(unit)
            except BaseException as error:
                errors.append('unit verification ' + unit + ': ' + repr(error))
                unsafe.append(unit)
        self.evidence['cleanup'] = {'units_inactive': not unsafe, 'group_removed': False,
                                    'temporary_directory': str(self.base)}
        if unsafe:
            self.evidence['cleanup_errors'] = errors
            raise RuntimeError('Fixture units still active or unverified; preserve group/storage: ' + repr(unsafe))
        if self.group_created:
            try:
                group = grp.getgrnam(self.group)
            except KeyError:
                group = None
            if group is not None:
                if self.group_gid is None or group.gr_gid != self.group_gid or group.gr_mem:
                    raise RuntimeError('Fixture group identity changed; preserve it and storage')
                self.command('groupdel', self.group, check=False)
                try:
                    grp.getgrnam(self.group)
                except KeyError:
                    pass
                else:
                    raise RuntimeError('Fixture group still exists; preserve storage')
        self.evidence['cleanup']['group_removed'] = True
        self.evidence['hook_logs'] = attempt('hook logs', lambda: {
            str(p.relative_to(self.base)): p.read_text() for p in self.root.glob('*/*.hook.log')}, {})
        self.evidence['final_states'] = attempt('final states', lambda: {
            letter: self.state(letter) for letter in 'abc'}, {})
        validate_base(self.base)
        if not shutil.rmtree.avoids_symlink_attacks:
            raise RuntimeError('Refusing fixture removal without symlink-safe rmtree')
        shutil.rmtree(self.base)
        if self.base.exists():
            raise RuntimeError('Fixture directory still exists')
        self.evidence['cleanup']['temporary_directory_removed'] = True
        if errors:
            self.evidence['cleanup_errors'] = errors
            raise RuntimeError('Fixture cleanup completed with evidence/command errors: ' + repr(errors))

    def run(self):
        def expired(_signum, _frame):
            raise TimeoutError('Absolute fixture deadline exceeded (240 seconds)')
        signal.signal(signal.SIGALRM, expired)
        signal.alarm(240)
        try:
            self.setup()
            self.tests()
            self.evidence['passed'] = True
        except BaseException as error:
            self.evidence.update(passed=False, error=repr(error), traceback=traceback.format_exc())
        finally:
            signal.alarm(0)
            try:
                self.cleanup()
            except BaseException as error:
                self.evidence.update(passed=False, cleanup_error=repr(error), cleanup_traceback=traceback.format_exc())
        self.evidence['finished_at'] = time.time()
        self.evidence['elapsed_seconds'] = self.evidence['finished_at'] - self.evidence['started_at']
        print('EVIDENCE_JSON=' + json.dumps(self.evidence), flush=True)
        return 0 if self.evidence.get('passed') else 1


def local(args):
    source = Path(args.source).resolve()
    reviewed_hook_path(source.read_bytes())  # Reject extension regressions before SSH or fixture allocation.
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    create = subprocess.run(['rtk', 'proxy', 'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', args.host,
                             'mktemp -d /var/lib/ciq-fixture-XXXXXXXX'], capture_output=True, text=True, timeout=20, check=True)
    base = create.stdout.strip()
    assert re.fullmatch(r'/var/lib/ciq-fixture-[A-Za-z0-9]+', base), base
    subprocess.run(['rtk', 'proxy', 'scp', '-q', str(Path(__file__).resolve()), args.host + ':' + base + '/run-fixtures.py'], check=True, timeout=30)
    subprocess.run(['rtk', 'proxy', 'scp', '-q', str(source), args.host + ':' + base + '/shared-ci-queue.source.py'], check=True, timeout=30)
    remote = 'python3 ' + shlex.quote(base + '/run-fixtures.py') + ' --remote --base ' + shlex.quote(base) + ' --source ' + shlex.quote(base + '/shared-ci-queue.source.py')
    result = subprocess.run(['rtk', 'proxy', 'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', args.host, remote],
                            capture_output=True, text=True, timeout=300)
    (output / 'replay-stdout.log').write_text(result.stdout)
    (output / 'replay-stderr.log').write_text(result.stderr)
    for line in result.stdout.splitlines():
        if not line.startswith('EVIDENCE_JSON='):
            print(line)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    match = next((line[len('EVIDENCE_JSON='):] for line in result.stdout.splitlines() if line.startswith('EVIDENCE_JSON=')), None)
    if match:
        evidence = json.loads(match)
        (output / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print(json.dumps({'passed': evidence.get('passed'), 'elapsed_seconds': evidence['elapsed_seconds'],
                          'tests': len(evidence['tests']), 'evidence': str(output / 'evidence.json'),
                          'error': evidence.get('error'), 'cleanup_error': evidence.get('cleanup_error')}))
    return result.returncode


def self_test():
    """Exercise destructive-operation guards locally; no SSH/systemd is invoked."""
    import tempfile
    import types
    import unittest
    from unittest.mock import Mock, patch

    class Guards(unittest.TestCase):
        def test_extensionless_hook_is_rejected_before_replay(self):
            with self.assertRaisesRegex(RuntimeError, 'supported .sh'):
                reviewed_hook_path(b"HOOK = Path('/usr/local/libexec/shared-ci-queue-hook')\n")
            self.assertEqual(reviewed_hook_path(b"HOOK = Path('/usr/local/libexec/shared-ci-queue-hook.sh')\n").suffix, '.sh')
            self.assertEqual(hook_command('/fixture/hook.sh'), ['/usr/bin/bash', '-e', '/fixture/hook.sh'])

        def test_arbitrary_parent_is_rejected_before_inspection(self):
            with self.assertRaisesRegex(RuntimeError, 'Unsafe fixture directory'):
                validate_base(Path('/srv/telovporiadke/ciq-fixture-TEST'))

        def test_symlink_fixture_base_is_rejected(self):
            with tempfile.TemporaryDirectory() as temporary:
                parent = Path(temporary).resolve()
                target = parent / 'keep'
                target.mkdir()
                base = parent / 'ciq-fixture-TEST'
                base.symlink_to(target)
                with patch.dict(globals(), FIXTURE_PARENT=parent):
                    with self.assertRaisesRegex(RuntimeError, 'Unsafe fixture directory'):
                        validate_base(base)
                self.assertTrue(target.is_dir())

    class Cleanup(unittest.TestCase):
        def setUp(self):
            self.temp = tempfile.TemporaryDirectory()
            self.addCleanup(self.temp.cleanup)
            self.base = Path(self.temp.name) / 'ciq-fixture-TEST'
            self.base.mkdir()
            # Filesystem ownership is checked separately; these tests run as the
            # Mac user and stub only that guard, never subprocess execution.
            with patch.dict(globals(), validate_base=lambda *args, **kwargs: None):
                self.replay = Replay(self.base, b'fixture source')
            self.replay.root.mkdir()
            self.unit = self.replay.units['a']
            guard = patch.dict(globals(), validate_base=lambda *args, **kwargs: None)
            guard.start()
            self.addCleanup(guard.stop)
            self.calls, self.active = [], True
            self.foreign, self.fail_journal = False, False
            self.replay.command = self.command

        def command(self, *args, **kwargs):
            self.calls.append(args)
            if args[0] == 'journalctl' and self.fail_journal:
                raise subprocess.TimeoutExpired(args, 12)
            if args[:2] == ('systemctl', 'show'):
                description = 'foreign service' if self.foreign else self.replay.description(self.unit)
                text = ('LoadState=loaded\nTransient=yes\nUser=valci\nSlice=system-valci.slice\n'
                        + 'Description=' + description + '\nActiveState=' + ('active' if self.active else 'inactive'))
                return types.SimpleNamespace(stdout=text, returncode=0)
            if args[:2] == ('systemctl', 'stop'):
                self.active = False
            return types.SimpleNamespace(stdout='', returncode=0)

        def test_evidence_failure_still_stops_owned_unit_and_removes_storage(self):
            self.replay.created_units.append(self.unit)
            self.fail_journal = True
            bad = self.replay.root / 'events'
            bad.mkdir()
            (bad / 'bad.event.json').write_text('invalid json')
            with self.assertRaisesRegex(RuntimeError, 'cleanup completed with'):
                self.replay.cleanup()
            self.assertIn(('systemctl', 'stop', self.unit), self.calls)
            self.assertFalse(self.base.exists())
            self.assertTrue(self.replay.evidence['cleanup']['units_inactive'])

        def test_unknown_unit_is_never_stopped_or_storage_removed(self):
            self.replay.created_units.append(self.unit)
            self.foreign = True
            with self.assertRaisesRegex(RuntimeError, 'unverified'):
                self.replay.cleanup()
            self.assertFalse(any(c[:2] == ('systemctl', 'stop') for c in self.calls))
            self.assertTrue(self.base.exists())

        def test_indeterminate_launch_registers_cleanup_before_command(self):
            def launch(*args, **kwargs):
                if args[:2] == ('systemctl', 'show'):
                    return types.SimpleNamespace(stdout='LoadState=not-found', returncode=0)
                self.assertIn(self.unit, self.replay.created_units)
                raise subprocess.TimeoutExpired(args, 12)
            self.replay.command = launch
            with self.assertRaises(subprocess.TimeoutExpired):
                self.replay.launch(self.unit, 'systemd-run', '--unit=' + self.unit)
            self.replay.command = self.command
            self.replay.cleanup()
            self.assertIn(('systemctl', 'stop', self.unit), self.calls)
            self.assertFalse(self.base.exists())

        def test_preexisting_unit_is_not_registered_for_cleanup(self):
            with self.assertRaisesRegex(RuntimeError, 'already exists'):
                self.replay.launch(self.unit, 'systemd-run', '--unit=' + self.unit)
            self.assertEqual(self.replay.created_units, [])
            self.assertFalse(any(c[0] == 'systemd-run' for c in self.calls))

        def test_signal_refuses_production_cgroup(self):
            self.replay.process_identity = Mock(return_value={'start': 1, 'group': '/system.slice/mysql.service'})
            with patch.object(os, 'pidfd_open', create=True) as opened:
                with self.assertRaisesRegex(RuntimeError, 'outside fixture'):
                    self.replay.signal(123)
                opened.assert_not_called()

        def test_signal_refuses_changed_identity_and_closes_pidfd(self):
            group = '/system.slice/system-valci.slice/' + self.unit
            self.replay.process_identity = Mock(side_effect=[{'start': 1, 'group': group}, {'start': 2, 'group': group}])
            self.replay.owned_unit = Mock()
            with patch.object(os, 'pidfd_open', return_value=77, create=True), patch.object(os, 'close') as closed, \
                    patch.object(signal, 'pidfd_send_signal', create=True) as sent:
                with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                    self.replay.signal(123)
                sent.assert_not_called()
                closed.assert_called_once_with(77)

        def test_signal_uses_verified_pidfd(self):
            identity = {'start': 1, 'group': '/system.slice/system-valci.slice/' + self.unit}
            self.replay.process_identity = Mock(return_value=identity)
            self.replay.owned_unit = Mock()
            with patch.object(os, 'pidfd_open', return_value=77, create=True), patch.object(os, 'close') as closed, \
                    patch.object(signal, 'pidfd_send_signal', create=True) as sent:
                self.replay.signal(123)
                sent.assert_called_once_with(77, signal.SIGKILL)
                closed.assert_called_once_with(77)

    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(case) for case in [Guards, Cleanup])
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source')
    parser.add_argument('--self-test', action='store_true', help='Local mocked safety checks; never invokes SSH/systemd')
    parser.add_argument('--host', default='gmk-root')
    parser.add_argument('--output', default='.private/reports/ci-queue-linux')
    parser.add_argument('--remote', action='store_true')
    parser.add_argument('--base', type=Path)
    parser.add_argument('--supervisor')
    parser.add_argument('--worker')
    parser.add_argument('--orphan')
    arguments = parser.parse_args()
    if arguments.self_test:
        sys.exit(self_test())
    elif arguments.supervisor:
        supervisor(json.loads(Path(arguments.supervisor).read_text()))
    elif arguments.worker:
        sys.exit(worker(json.loads(arguments.worker)))
    elif arguments.orphan:
        orphan(json.loads(arguments.orphan))
    elif arguments.remote:
        sys.exit(Replay(arguments.base, Path(arguments.source).read_bytes()).run())
    else:
        sys.exit(local(arguments))
