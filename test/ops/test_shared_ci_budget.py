"""Safety contracts for shared host CI migration; no actual systemd mutations."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

FILE = Path(__file__).resolve().parents[2] / 'scripts/ops/shared-ci-budget.py'
spec = importlib.util.spec_from_file_location('budget', FILE)
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.runtime = patch.object(budget, 'RUNTIME', Path(self.directory.name))
        self.runtime.start()
        self.addCleanup(self.runtime.stop)
        self.states = {u: {'ActiveState': 'active', 'ControlGroup': f'/system.slice/{u}', 'Restart': 'always', 'FreezerState': 'running'}
                       for u in budget.UNITS}

    def command(self, *args):
        self.calls.append(args)
        if args[:2] == ('systemctl', 'freeze'):
            self.states[args[2]]['FreezerState'] = 'frozen'
        if args[:2] == ('systemctl', 'thaw'):
            self.states[args[2]]['FreezerState'] = 'running'
        if args == ('systemctl', 'daemon-reload'):
            for unit in budget.RUNNERS:
                path = budget.RUNTIME / f'{unit}.d/zzzz-shared-ci-budget-drain.conf'
                self.states[unit]['Restart'] = 'no' if path.exists() else 'always'
        if args[:2] == ('systemctl', 'start') and args[2] in self.states:
            self.states[args[2]]['ActiveState'] = 'active'
            self.states[args[2]]['ControlGroup'] = f'/system.slice/{budget.SLICE}/{args[2]}'
        return ''

    def kill(self, group):
        unit = Path(group).name
        self.calls.append(('cgroup', 'kill', unit))
        self.states[unit]['ActiveState'] = 'failed'


    def reconcile(self, busy=(), fail_worker_scan=False):
        def workers(group):
            if fail_worker_scan:
                raise RuntimeError('cgroup unavailable')
            return [123] if any(group.endswith('/' + u) for u in busy) else []
        with patch.object(budget, 'properties', side_effect=lambda u: self.states[u].copy()), \
                patch.object(budget, 'run', side_effect=self.command), \
                patch.object(budget, 'kill_frozen_idle', side_effect=self.kill), \
                patch.object(budget, 'cgroup_workers', side_effect=workers):
            return budget.reconcile()

    def test_busy_runner_and_database_are_never_stopped(self):
        active = budget.RUNNERS[0]
        result = self.reconcile(busy=[active])
        stopped = [c[2] for c in self.calls if c[:2] == ('systemctl', 'stop')]
        self.assertNotIn(active, stopped)
        self.assertNotIn(budget.DATABASE, stopped)
        self.assertEqual(set(stopped), set(budget.RUNNERS[1:]))
        # Busy work resumes before any idle service is restarted.
        self.assertLess(self.calls.index(('systemctl', 'thaw', active)),
                        next(i for i, c in enumerate(self.calls) if c[1] == 'stop'))
        self.assertEqual(len(result['pending']), 2)

    def test_idle_database_migrates_before_listeners_restart(self):
        result = self.reconcile()
        stopped = [c[2] for c in self.calls if c[:2] == ('systemctl', 'stop')]
        self.assertEqual(stopped, [budget.DATABASE, *budget.RUNNERS])
        self.assertEqual(result['pending'], [])
        freezes = [c for c in self.calls if c[1] == 'freeze']
        self.assertEqual(len(freezes), 4)
        for unit in budget.RUNNERS:
            kill = ('cgroup', 'kill', unit)
            self.assertLess(self.calls.index(('systemctl', 'freeze', unit)), self.calls.index(kill))
            self.assertLess(self.calls.index(kill), self.calls.index(('systemctl', 'stop', unit)))
            self.assertLess(self.calls.index(('systemctl', 'start', unit)), self.calls.index(('systemctl', 'thaw', unit)))
        self.assertTrue(all(s['Restart'] == 'always' for s in self.states.values()))
        self.assertFalse(list(budget.RUNTIME.glob('*/*.conf')))

    def test_autorestart_override_must_take_effect_before_freezing(self):
        original = self.command
        def command(*args):
            if args != ('systemctl', 'daemon-reload'):
                return original(*args)
            return ''  # Simulate a higher-priority conflicting Restart= policy.
        with patch.object(budget, 'properties', side_effect=lambda u: self.states[u].copy()), \
                patch.object(budget, 'run', side_effect=command):
            with self.assertRaisesRegex(RuntimeError, 'suppress automatic restart'):
                budget.reconcile()
        self.assertFalse(any(c[1] in ('freeze', 'kill', 'stop', 'start') for c in self.calls))
        self.assertFalse(list(budget.RUNTIME.glob('*/*.conf')))

    def test_transitional_or_inactive_listener_prevents_database_restart(self):
        for state in ['activating', 'deactivating', 'failed', 'inactive']:
            with self.subTest(state=state):
                self.setUp()
                self.states[budget.RUNNERS[0]]['ActiveState'] = state
                result = self.reconcile()
                self.assertNotIn(('systemctl', 'stop', budget.DATABASE), self.calls)
                self.assertIn(budget.DATABASE, [x['unit'] for x in result['pending']])

    def test_one_thaw_failure_does_not_leave_other_units_frozen(self):
        original = self.command
        def command(*args):
            original(*args)
            if args == ('systemctl', 'thaw', budget.RUNNERS[0]):
                raise RuntimeError('thaw unavailable')
            return ''
        with patch.object(budget, 'properties', side_effect=lambda u: self.states[u].copy()), \
                patch.object(budget, 'run', side_effect=command), \
                patch.object(budget, 'cgroup_workers', side_effect=RuntimeError('scan refused')):
            with self.assertRaisesRegex(RuntimeError, 'recover immediately'):
                budget.reconcile()
        self.assertEqual({c[2] for c in self.calls if c[1] == 'thaw'}, set(budget.RUNNERS))

    def test_already_migrated_services_are_not_frozen_or_restarted(self):
        for unit in budget.UNITS:
            self.states[unit]['ControlGroup'] = f'/system.slice/{budget.SLICE}/{unit}'
        self.assertEqual(self.reconcile()['migrated'], [])
        self.assertEqual(self.calls, [])

    def test_scan_failure_thaws_every_frozen_unit(self):
        with self.assertRaises(RuntimeError):
            self.reconcile(fail_worker_scan=True)
        self.assertEqual({c[2] for c in self.calls if c[1] == 'freeze'},
                         {c[2] for c in self.calls if c[1] == 'thaw'})
        self.assertFalse(any(c[1] in ('stop', 'start') for c in self.calls))

    def test_inactive_service_is_not_started(self):
        unit = budget.RUNNERS[-1]
        self.states[unit] = {'ActiveState': 'inactive', 'ControlGroup': ''}
        result = self.reconcile()
        self.assertFalse(any(c[-1] == unit for c in self.calls))
        self.assertIn(unit, [x['unit'] for x in result['pending']])

    def test_production_units_are_not_in_budget(self):
        files = budget.managed_files()
        self.assertEqual(len(files), 6)
        self.assertNotIn('actions-runner.service', budget.UNITS)
        self.assertFalse(any('php' in u or u == 'mysql.service' for u in budget.UNITS))


class InspectionTests(unittest.TestCase):
    def test_kernel_kill_requires_frozen_group(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            directory = root / 'system.slice/runner.service'
            directory.mkdir(parents=True)
            events = directory / 'cgroup.events'
            events.write_text('populated 1\nfrozen 0\n')
            kill = directory / 'cgroup.kill'
            kill.write_text('0\n')
            with self.assertRaises(RuntimeError):
                budget.kill_frozen_idle('/system.slice/runner.service', root)
            self.assertEqual(kill.read_text(), '0\n')
            events.write_text('populated 1\nfrozen 1\n')
            budget.kill_frozen_idle('/system.slice/runner.service', root)
            self.assertEqual(kill.read_text(), '1\n')

    def test_nested_worker_is_detected_without_returning_arguments(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            cg = root / 'cgroup/system.slice/runner.service/child'
            cg.mkdir(parents=True)
            (cg / 'cgroup.procs').write_text('12\n13\n14\n')
            for pid, comm, cmd in [(12, 'Runner.Listener', b'listener'),
                                   (13, 'dotnet', b'/runner/Runner.Worker\0job'),
                                   (14, 'Runner.Worker', b'worker')]:
                p = root / f'proc/{pid}'
                p.mkdir(parents=True)
                (p / 'comm').write_text(comm)
                (p / 'cmdline').write_bytes(cmd)
            self.assertEqual(budget.cgroup_workers('/system.slice/runner.service',
                                                  root / 'cgroup', root / 'proc'), [13, 14])

    def test_missing_cgroup_fails_closed(self):
        with tempfile.TemporaryDirectory() as name:
            with self.assertRaises(RuntimeError):
                budget.cgroup_workers('/missing', Path(name))

    def test_atomic_write_refuses_symlink(self):
        with tempfile.TemporaryDirectory() as name:
            target = Path(name) / 'target'
            target.write_text('preserve')
            link = Path(name) / 'link'
            link.symlink_to(target)
            with self.assertRaises(RuntimeError):
                budget.atomic_write(link, b'replace')
            self.assertEqual(target.read_text(), 'preserve')


if __name__ == '__main__':
    unittest.main()
