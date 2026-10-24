"""Fail-closed queue safety contracts; real processes are exercised on Linux."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch, Mock

FILE = Path(__file__).resolve().parents[2] / 'scripts/ops/shared-ci-queue.py'
spec = importlib.util.spec_from_file_location('queue_gate', FILE)
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['ROOT', 'PROC', 'CGROUP']:
            target = self.root / name
            target.mkdir()
            p = patch.object(queue, name, target)
            p.start()
            self.addCleanup(p.stop)
        self.unit = next(iter(queue.RUNNERS))
        self.context = {'unit': self.unit, 'tracking_id': 'test-marker', 'repository': 'valbarko/telovporiadke',
                        'workflow': 'check', 'job': 'check',
                        'worker': {'pid': 123, 'start': 456, 'group': '/system.slice/system-valci.slice/' + self.unit}}
        for unit in queue.RUNNERS:
            (queue.ROOT / unit).mkdir()

    def test_lost_keeper_latch_blocks_next_job(self):
        queue.write_state(self.context, 'holding', 'worker')
        with self.assertRaisesRegex(RuntimeError, 'Unreleased CI lease'):
            queue.check_latches()
        # Starting the next hook must not overwrite the earlier worker's lease.
        self.assertEqual(queue.load_state(self.unit)['worker']['pid'], 123)

    def test_only_terminal_leases_allow_admission(self):
        queue.write_state(self.context, 'released', 'complete')
        queue.check_latches()
        queue.write_state(self.context, 'incident', 'keeper-failed')
        with self.assertRaises(RuntimeError):
            queue.check_latches()

    def test_corrupt_or_foreign_cgroup_state_fails_closed(self):
        queue.state_path(self.unit).write_text('not json')
        with self.assertRaises(ValueError):
            queue.check_latches()
        context = {**self.context, 'worker': {**self.context['worker'], 'group': '/system.slice/mysql.service'}}
        queue.write_state(context, 'holding')
        with self.assertRaisesRegex(RuntimeError, 'Invalid queue state'):
            queue.check_latches()

    def test_atomic_state_is_private_and_refuses_symlinks(self):
        queue.write_state(self.context, 'holding')
        self.assertEqual(queue.state_path(self.unit).stat().st_mode & 0o777, 0o640)
        queue.state_path(self.unit).unlink()
        target = self.root / 'preserve'
        target.write_text('preserve')
        queue.state_path(self.unit).symlink_to(target)
        with self.assertRaises(RuntimeError):
            queue.write_state(self.context, 'released')
        self.assertEqual(target.read_text(), 'preserve')

    def test_worker_pid_reuse_is_not_original_worker(self):
        with patch.object(queue, 'read_process', return_value={'start': 457, 'state': 'S'}):
            self.assertFalse(queue.same_process(self.context['worker']))
        with patch.object(queue, 'read_process', return_value={'start': 456, 'state': 'Z'}):
            self.assertFalse(queue.same_process(self.context['worker']))

    def test_orphan_scan_only_matches_marker_and_does_not_return_environment(self):
        cg = queue.CGROUP / self.context['worker']['group'].lstrip('/')
        cg.mkdir(parents=True)
        (cg / 'cgroup.procs').write_text('123\n124\n125\n')
        for pid, marker in [(123, 'test-marker'), (124, 'other'), (125, '')]:
            p = queue.PROC / str(pid)
            p.mkdir()
            (p / 'environ').write_bytes(b'SECRET=not-output\0RUNNER_TRACKING_ID=' + marker.encode() + b'\0')
        with patch.object(queue, 'read_process', return_value={'start': 456, 'state': 'S'}):
            self.assertEqual(queue.marker_processes(self.context), [123])
        with patch.object(queue, 'read_process', return_value={'start': 456, 'state': 'S'}), \
                patch.object(queue, 'has_marker', side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):
                queue.marker_processes(self.context)

    def test_light_allowlist_is_exact_and_unknown_jobs_are_heavy(self):
        light = {**self.context, 'workflow': 'Site placeholder', 'job': 'validate'}
        with patch.object(queue, 'worker_context', return_value=light), patch.object(queue, 'open_lock') as lock:
            queue.hook()
            lock.assert_not_called()
        with patch.object(queue, 'worker_context', return_value={**light, 'workflow': 'another'}), \
                patch.object(queue, 'open_lock', side_effect=RuntimeError('heavy lock required')):
            with self.assertRaisesRegex(RuntimeError, 'heavy lock required'):
                queue.hook()

    def test_keeper_exec_has_no_job_environment_and_waits_for_ack(self):
        child = Mock()
        # Separate from actual Popen/FD ownership: test the missing-ack branch.
        with patch.object(queue.subprocess, 'Popen', return_value=child) as launch, \
                patch.object(queue.json, 'dump'), \
                patch.object(queue.select, 'select', return_value=([], [], [])):
            with self.assertRaisesRegex(RuntimeError, 'did not acknowledge'):
                queue.start_keeper(55, self.context)
            self.assertEqual(launch.call_args.kwargs['env'], {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
            self.assertTrue(launch.call_args.kwargs['start_new_session'])
            child.terminate.assert_called_once()

    def test_wait_timeout_is_bounded(self):
        with patch.object(queue.fcntl, 'flock', side_effect=BlockingIOError), \
                patch.object(queue.time, 'monotonic', side_effect=[0, 2]):
            with self.assertRaisesRegex(RuntimeError, 'wait exceeded'):
                queue.acquire(55, limit=1)

    def test_indeterminate_freeze_error_still_thaws_listener(self):
        fd = os.open(self.root / 'recovery.lock', os.O_CREAT | os.O_RDWR, 0o600)
        calls = []
        def run(*args):
            calls.append(args)
            if args[1] == 'freeze':
                raise RuntimeError('freeze timed out after kernel accepted it')
        fake = types.SimpleNamespace(properties=lambda u: {'ActiveState': 'active', 'FreezerState': 'running'}, run=run)
        with patch.object(queue, 'open_lock', return_value=fd), patch.object(queue, 'budget_module', return_value=fake):
            with self.assertRaisesRegex(RuntimeError, 'freeze timed out'):
                queue.recover(self.unit)
        self.assertEqual(calls, [('systemctl', 'freeze', self.unit), ('systemctl', 'thaw', self.unit)])

    def test_recovery_preserves_another_operations_freeze(self):
        fd = os.open(self.root / 'recovery.lock', os.O_CREAT | os.O_RDWR, 0o600)
        fake = types.SimpleNamespace(properties=lambda u: {'ActiveState': 'active', 'FreezerState': 'frozen'}, run=Mock())
        with patch.object(queue, 'open_lock', return_value=fd), patch.object(queue, 'budget_module', return_value=fake):
            with self.assertRaisesRegex(RuntimeError, 'already frozen'):
                queue.recover(self.unit)
        fake.run.assert_not_called()

    def test_recovery_refuses_production_before_inspection(self):
        with patch.object(queue, 'open_lock') as lock:
            with self.assertRaisesRegex(RuntimeError, 'managed CI units'):
                queue.recover('mysql.service')
        lock.assert_not_called()

    def test_install_failure_removes_only_unchanged_owned_files(self):
        module = queue.budget_module()
        backup_root = self.root / 'backups'
        backup_root.mkdir()
        paths = {self.root / 'installed/one': b'one', self.root / 'installed/two': b'two'}
        workspace = self.root / 'runner'
        workspace.mkdir()
        (workspace / '.env').write_text('LANG=C.UTF-8\n')
        calls = []
        def run(*args):
            calls.append(args)
            if args[:2] == ('systemctl', 'show'):
                if 'WorkingDirectory' in args:
                    return str(workspace)
                return 'User=' + queue.RUNNERS[args[2]][0] + '\nEnvironment='
            if args[0] == 'systemd-analyze':
                (self.root / 'installed/two').write_bytes(b'operator-change')
                raise RuntimeError('unit validation failed')
            return ''
        with patch.object(module, 'preflight'), patch.object(module, 'properties', return_value={}), \
                patch.object(module, 'in_target', return_value=True), patch.object(module, 'run', side_effect=run), \
                patch.object(queue, 'budget_module', return_value=module), patch.object(queue, 'BACKUPS', backup_root), \
                patch.object(queue, 'ROOT', self.root / 'not-created-yet'), \
                patch.object(queue, 'installed_files', return_value=paths), patch.object(queue.grp, 'getgrnam', side_effect=KeyError):
            backup = backup_root / 'shared-ci-queue-fixture'
            with self.assertRaisesRegex(RuntimeError, 'unit validation failed'):
                queue.install(backup)
        self.assertFalse((self.root / 'installed/one').exists())
        self.assertEqual((self.root / 'installed/two').read_bytes(), b'operator-change')
        self.assertTrue((backup / 'manifest.json').is_file())
        self.assertEqual((backup / 'manifest.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(calls[-1], ('systemctl', 'daemon-reload'))
        self.assertFalse(any('stop' in c or 'restart' in c for c in calls))

    def test_reconcile_never_restarts_holding_or_incident_listener(self):
        queue.write_state(self.context, 'holding')
        fake = types.SimpleNamespace(
            UNITS=list(queue.RUNNERS), SLICE='system-valci.slice', properties=lambda u: {},
            in_target=lambda state, target: True,
            reconcile=Mock(return_value={'pending': [], 'migrated': []}))
        with patch.object(queue, 'budget_module', return_value=fake), \
                patch.object(queue, 'runtime_enabled', return_value=False):
            result = queue.reconcile()
        self.assertNotIn(self.unit, fake.reconcile.call_args.kwargs['restart_units'])
        self.assertIn(self.unit, [r['unit'] for r in result['pending']])

    def test_production_runner_is_not_hooked(self):
        files = queue.installed_files()
        self.assertEqual(len(files), 8)
        self.assertFalse(any('/actions-runner.service.d/' in str(p) for p in files))
        self.assertFalse(any('mysql.service.d' in str(p) or 'php' in str(p) for p in files))
        self.assertNotIn('actions-runner.service', queue.RUNNERS)
        for p, value in files.items():
            if p.name == '95-shared-ci-queue.conf':
                self.assertNotIn(b'ExecStart=', value)
                self.assertNotIn(b'EnvironmentFile=', value)

    def test_started_hook_uses_runner_supported_shell_extension(self):
        self.assertEqual(queue.HOOK, Path('/usr/local/libexec/shared-ci-queue-hook.sh'))
        files = queue.installed_files()
        self.assertIn(queue.HOOK, files)
        self.assertTrue(files[queue.HOOK].startswith(b'#!/bin/sh\n'))
        for path, content in files.items():
            if path.name == '95-shared-ci-queue.conf':
                self.assertIn(b'ACTIONS_RUNNER_HOOK_JOB_STARTED=' + str(queue.HOOK).encode(), content)


if __name__ == '__main__':
    unittest.main()
