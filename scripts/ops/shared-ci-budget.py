#!/usr/bin/env python3
"""Install a shared CI cgroup budget, moving only idle, frozen runner services."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile

SLICE = 'system-valci.slice'
RUNNERS = (
    'telo-ci.service',
    'actions.runner.valbarko-vbclub-training.gmk-val-ci-tvk.service',
    'actions.runner.valbarko-gde-moi-klienty.gmk-val-ci-gmk.service',
    'actions.runner.valbarko-ddxmoremall.gmk-val-ci-ddxmoremall.service',
)
DATABASE = 'tvk-ci-mysql.service'
UNITS = (*RUNNERS, DATABASE)
SYSTEMD = Path('/etc/systemd/system')
RUNTIME = Path('/run/systemd/system')
CGROUP = Path('/sys/fs/cgroup')
SLICE_CONFIG = '''[Unit]
Description=Shared CI budget, isolated from production services

[Slice]
CPUAccounting=yes
CPUQuota=200%
CPUWeight=20
MemoryAccounting=yes
MemoryHigh=3G
MemoryMax=4G
IOAccounting=yes
IOWeight=20
'''
DROP_IN = f'[Service]\nSlice={SLICE}\n'


def run(*args: str) -> str:
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=60).strip()


def properties(unit: str) -> dict[str, str]:
    text = run('systemctl', 'show', unit, '-p', 'LoadState', '-p', 'ActiveState',
               '-p', 'ControlGroup', '-p', 'Slice', '-p', 'MainPID', '-p', 'Restart')
    return dict(line.split('=', 1) for line in text.splitlines() if '=' in line)


def cgroup_workers(group: str, root: Path = CGROUP, proc: Path = Path('/proc')) -> list[int]:
    """Inspect the whole service subtree; never return arguments or environment."""
    if not group.startswith('/') or '..' in Path(group).parts:
        raise RuntimeError('Invalid cgroup path')
    directory = root / group.lstrip('/')
    if not directory.is_dir():
        raise RuntimeError('Service cgroup disappeared; retry without restarting')
    found = set()
    for file in directory.rglob('cgroup.procs'):
        for value in file.read_text().split():
            pid = int(value)
            try:
                comm = (proc / value / 'comm').read_text().strip()
                args = (proc / value / 'cmdline').read_bytes()
            except FileNotFoundError:
                continue
            if comm.startswith('Runner.Worker') or b'Runner.Worker' in args:
                found.add(pid)
    return sorted(found)


def managed_files() -> dict[Path, str]:
    result = {SYSTEMD / SLICE: SLICE_CONFIG}
    result.update({SYSTEMD / f'{u}.d/90-shared-ci-budget.conf': DROP_IN for u in UNITS})
    return result


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def atomic_write(path: Path, data: bytes, mode: int = 0o644) -> None:
    if path.is_symlink() or path.parent.is_symlink():
        raise RuntimeError(f'Refusing symlink: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.ci-budget-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def preflight() -> None:
    if socket.gethostname() != 'gmk-prod-1' or not (CGROUP / 'cgroup.controllers').is_file():
        raise RuntimeError('This policy is scoped to gmk-prod-1 with cgroup v2')
    for unit in UNITS:
        if properties(unit).get('LoadState') != 'loaded':
            raise RuntimeError(f'Required unit missing: {unit}')


def snapshot() -> dict:
    result = {}
    for unit in UNITS:
        state = properties(unit)
        state['workers'] = (cgroup_workers(state['ControlGroup'])
                            if unit in RUNNERS and state.get('ActiveState') == 'active' else [])
        result[unit] = state
    return result


def install(backup: Path) -> dict:
    if backup.exists() or backup.parent != Path('/var/backups') or not backup.name.startswith('shared-ci-budget-'):
        raise RuntimeError('Use a fresh /var/backups/shared-ci-budget-* directory')
    files = managed_files()
    for path in files:
        if path.exists() or path.is_symlink():
            raise RuntimeError(f'Managed path already exists; inspect instead of overwriting: {path}')
    before = snapshot()
    if any(s.get('Slice') != 'system.slice' for s in before.values()):
        raise RuntimeError('Existing slice policy differs; inspect before migration')
    backup.mkdir(mode=0o700)
    state = {'version': 1, 'created_at': dt.datetime.now(dt.timezone.utc).isoformat(),
             'source_sha256': digest(Path(__file__).read_bytes()),
             'before': before,
             'unit_configs': {unit: run('systemctl', 'cat', unit) for unit in UNITS},
             'files': {str(p): digest(v.encode()) for p, v in files.items()}}
    atomic_write(backup / 'manifest.json', json.dumps(state, indent=2).encode(), 0o600)
    # Only new dedicated files are installed. Existing unit files and drop-ins stay intact.
    try:
        for path, value in files.items():
            atomic_write(path, value.encode())
        run('systemd-analyze', 'verify', str(SYSTEMD / SLICE), *UNITS)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', SLICE)
    except Exception:
        for path, value in files.items():
            if path.is_file() and digest(path.read_bytes()) == digest(value.encode()):
                path.unlink()
        run('systemctl', 'daemon-reload')
        raise
    return {'installed': True, 'backup': str(backup), 'migration': 'pending; run reconcile'}


def in_target(state: dict, target: str) -> bool:
    group = state.get('ControlGroup', '')
    return f'/{SLICE}/' in group if target == SLICE else group.count('/') == 2 and group.startswith('/system.slice/')


def reconcile(target: str = SLICE) -> dict:
    migrated, pending, frozen, temporary = [], [], [], []
    try:
        # Freeze listeners before testing idleness, preventing job startup during inspection.
        # Busy workers are thawed in finally and are never stopped or restarted.
        states = {unit: properties(unit) for unit in UNITS}
        drain_paths = [RUNTIME / f'{unit}.d/zzzz-shared-ci-budget-drain.conf'
                       for unit in RUNNERS if states[unit]['ActiveState'] == 'active'
                       and not in_target(states[unit], target)]
        if any(p.exists() or p.is_symlink() for p in drain_paths):
            raise RuntimeError('A previous drain override exists; inspect before continuing')
        for path in drain_paths:
            temporary.append(path)
            atomic_write(path, b'[Service]\nRestart=no\n')
        if temporary:
            run('systemctl', 'daemon-reload')
            for unit in RUNNERS:
                if states[unit]['ActiveState'] == 'active' and not in_target(states[unit], target):
                    if properties(unit).get('Restart') != 'no':
                        raise RuntimeError('Cannot suppress automatic restart for idle migration')
        database_pending = not in_target(states[DATABASE], target)
        for unit in RUNNERS:
            if states[unit]['ActiveState'] == 'active' and (database_pending or not in_target(states[unit], target)):
                frozen.append(unit)
                run('systemctl', 'freeze', unit)
        busy = {unit for unit in frozen if cgroup_workers(states[unit]['ControlGroup'])}
        database_safe = len(frozen) == len(RUNNERS) and not busy
        for unit in busy:
            run('systemctl', 'thaw', unit)
            frozen.remove(unit)
        # A test DB can only restart while every managed runner is idle/frozen.
        for unit in (DATABASE, *RUNNERS):
            state = states[unit]
            if state['ActiveState'] != 'active':
                pending.append({'unit': unit, 'reason': 'inactive; original activation state preserved'})
            elif in_target(state, target):
                continue
            elif unit in busy or (unit == DATABASE and not database_safe):
                pending.append({'unit': unit, 'reason': 'active job or runner not frozen/idle; retry later'})
            else:
                if unit in RUNNERS:
                    # stop thaws a service before signaling it, so stop alone has a
                    # worker-start race. Kill only the inspected idle cgroup while
                    # still frozen; then finish the normal stop/start transaction.
                    run('systemctl', 'kill', '--kill-whom=all', '--signal=SIGKILL', unit)
                run('systemctl', 'stop', unit)
                if unit in frozen:
                    frozen.remove(unit)
                run('systemctl', 'start', unit)
                current = properties(unit)
                if current['ActiveState'] != 'active' or not in_target(current, target):
                    raise RuntimeError(f'{unit} did not enter expected cgroup')
                migrated.append(unit)
    finally:
        errors = []
        for unit in frozen:
            try:
                run('systemctl', 'thaw', unit)
            except Exception:
                errors.append(unit)
        for path in temporary:
            try:
                if path.is_symlink() or (path.exists() and path.read_bytes() != b'[Service]\nRestart=no\n'):
                    raise RuntimeError('Temporary drain override was modified')
                path.unlink(missing_ok=True)
            except Exception:
                errors.append(str(path))
        if temporary:
            try:
                run('systemctl', 'daemon-reload')
            except Exception:
                errors.append('systemd daemon-reload')
        if errors:
            raise RuntimeError('Incomplete drain cleanup; recover immediately: ' + ', '.join(errors))
    return {'target': target, 'migrated': migrated, 'pending': pending}


def rollback(backup: Path) -> dict:
    if backup.parent != Path('/var/backups') or not backup.name.startswith('shared-ci-budget-') or backup.is_symlink():
        raise RuntimeError('Unexpected backup path')
    saved = json.loads((backup / 'manifest.json').read_text())
    expected = managed_files()
    if set(saved['files']) != {str(p) for p in expected}:
        raise RuntimeError('Manifest paths do not match the allowlist')
    # Refuse to overwrite another operator's later changes. Repeated rollback is safe.
    for path, content in expected.items():
        if path.is_symlink() or (path.exists() and digest(path.read_bytes()) != saved['files'][str(path)]):
            raise RuntimeError(f'Managed file changed since install: {path}')
        if saved['files'][str(path)] != digest(content.encode()):
            raise RuntimeError('Rollback source differs from installed policy')
    for path in expected:
        path.unlink(missing_ok=True)
    run('systemctl', 'daemon-reload')
    result = reconcile('system.slice')
    if not result['pending']:
        run('systemctl', 'stop', SLICE)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'install', 'reconcile', 'rollback'])
    parser.add_argument('--backup', type=Path)
    args = parser.parse_args()
    preflight()
    if args.action != 'status' and os.geteuid() != 0:
        parser.error('Mutations require root')
    if args.action in ('install', 'rollback') and args.backup is None:
        parser.error('--backup is required')
    if args.action == 'install':
        result = install(args.backup)
    elif args.action == 'rollback':
        result = rollback(args.backup)
    elif args.action == 'reconcile':
        result = reconcile()
    else:
        result = {'units': snapshot(), 'slice': properties(SLICE)}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
