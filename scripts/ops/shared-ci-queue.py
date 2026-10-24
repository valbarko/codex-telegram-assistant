#!/usr/bin/env python3
"""One heavy job at a time on the existing production-host CI listeners."""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import grp
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import pwd
import select
import shlex
import socket
import stat
import subprocess
import sys
import tempfile
import time

ROOT = Path('/run/shared-ci-queue')
PROC = Path('/proc')
CGROUP = Path('/sys/fs/cgroup')
SYSTEMD = Path('/etc/systemd/system')
GROUP = 'shared-ci-queue'
LIBRARY = Path('/usr/local/libexec/shared-ci-queue.py')
HOOK = Path('/usr/local/libexec/shared-ci-queue-hook.sh')
OPERATOR = Path('/usr/local/sbin/shared-ci-queue')
TMPFILES = Path('/etc/tmpfiles.d/shared-ci-queue.conf')
WAIT_SECONDS = 1800
BACKUPS = Path('/var/backups')
RUNNERS = {
    'telo-ci.service': ('telo-ci', 'valbarko/telovporiadke'),
    'actions.runner.valbarko-vbclub-training.gmk-val-ci-tvk.service': ('valci', 'valbarko/vbclub-training'),
    'actions.runner.valbarko-gde-moi-klienty.gmk-val-ci-gmk.service': ('valci', 'valbarko/gde-moi-klienty'),
    'actions.runner.valbarko-ddxmoremall.gmk-val-ci-ddxmoremall.service': ('valci', 'valbarko/ddxmoremall'),
}
LIGHT = {('valbarko/vbclub-training', 'CI', 'classify'),
         ('valbarko/telovporiadke', 'Site placeholder', 'validate')}


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read_process(pid: int) -> dict | None:
    try:
        base = PROC / str(pid)
        fields = (base / 'stat').read_text().rsplit(')', 1)[1].split()
        group = next(line[3:] for line in (base / 'cgroup').read_text().splitlines() if line.startswith('0::'))
        return {'pid': pid, 'start': int(fields[19]), 'parent': int(fields[1]),
                'state': fields[0], 'comm': (base / 'comm').read_text().strip(), 'group': group}
    except (FileNotFoundError, ProcessLookupError):
        return None


def same_process(identity: dict) -> bool:
    current = read_process(identity['pid'])
    return bool(current and current['start'] == identity['start'] and current['state'] != 'Z')


def has_marker(pid: int, marker: str) -> bool:
    try:
        return ('RUNNER_TRACKING_ID=' + marker).encode() in (PROC / str(pid) / 'environ').read_bytes().split(b'\0')
    except (FileNotFoundError, ProcessLookupError):
        return False


def marker_processes(context: dict) -> list[int]:
    """Never return or log environment contents; unreadable live processes fail closed."""
    directory = CGROUP / context['worker']['group'].lstrip('/')
    if not directory.exists():
        return []  # The whole service cgroup and its processes have disappeared.
    def members():
        return {int(value) for file in directory.rglob('cgroup.procs') for value in file.read_text().split()}
    for _ in range(10):
        before = members()
        identities, found = {}, []
        for pid in before:
            process = read_process(pid)
            if process is None:
                break
            identities[pid] = process['start']
            if process['state'] != 'Z' and has_marker(pid, context['tracking_id']):
                found.append(pid)
        else:
            if before == members() and all((p := read_process(pid)) and p['start'] == start
                                            for pid, start in identities.items()):
                return sorted(found)
    raise RuntimeError('Unstable process inventory; preserve incident lease')


def state_path(unit: str) -> Path:
    if unit not in RUNNERS:
        raise RuntimeError('Unknown CI unit')
    return ROOT / unit / 'state.json'


def write_state(context: dict, status: str, phase: str = '') -> None:
    path = state_path(context['unit'])
    if path.is_symlink() or path.parent.is_symlink():
        raise RuntimeError('Unsafe state path')
    value = {**context, 'status': status, 'phase': phase, 'updated_at': now()}
    fd, temporary = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o640)
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def load_state(unit: str) -> dict | None:
    path = state_path(unit)
    if path.is_symlink() or path.parent.is_symlink():
        raise RuntimeError('Unsafe state path')
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    if (value.get('unit') != unit or value.get('status') not in {'holding', 'released', 'incident'}
            or not isinstance(value.get('tracking_id'), str) or not value['tracking_id']
            or len(value['tracking_id']) > 200 or '\0' in value['tracking_id']
            or not isinstance(value.get('worker', {}).get('start'), int)
            or not isinstance(value['worker'].get('pid'), int) or value['worker']['pid'] <= 0
            or value['worker'].get('group') != '/system.slice/system-valci.slice/' + unit):
        raise RuntimeError('Invalid queue state; operator inspection required')
    return value


def check_latches() -> None:
    for unit in RUNNERS:
        value = load_state(unit)
        if value and value['status'] != 'released':
            raise RuntimeError('Unreleased CI lease; operator inspection required: ' + unit)


def open_lock() -> int:
    fd = os.open(ROOT / 'slot.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        os.close(fd)
        raise RuntimeError('Unsafe shared CI lock inode')
    return fd


def worker_context() -> dict:
    unit = os.environ.get('SHARED_CI_QUEUE_UNIT', '')
    if unit not in RUNNERS or os.geteuid() != pwd.getpwnam(RUNNERS[unit][0]).pw_uid:
        raise RuntimeError('Unexpected queue identity')
    repository = os.environ.get('GITHUB_REPOSITORY', '')
    if repository != RUNNERS[unit][1]:
        raise RuntimeError('Runner repository mismatch')
    marker = os.environ.get('RUNNER_TRACKING_ID', '')
    if not marker or len(marker) > 200 or '\0' in marker:
        raise RuntimeError('Missing runner cleanup identity')
    current = read_process(os.getpid())
    for _ in range(16):
        if not current:
            break
        if current['comm'].startswith('Runner.Worker'):
            expected = '/system.slice/system-valci.slice/' + unit
            if current['group'] != expected:
                raise RuntimeError('Worker outside expected CI cgroup')
            return {'unit': unit, 'worker': current, 'tracking_id': marker,
                    'repository': repository, 'workflow': os.environ.get('GITHUB_WORKFLOW', ''),
                    'job': os.environ.get('GITHUB_JOB', '')}
        current = read_process(current['parent'])
    raise RuntimeError('No Runner.Worker ancestor')


def acquire(fd: int, limit: float = WAIT_SECONDS) -> None:
    start, notice = time.monotonic(), -60.0
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            check_latches()
            return
        except BlockingIOError:
            elapsed = time.monotonic() - start
            if elapsed >= limit:
                raise RuntimeError('Shared CI queue wait exceeded 30 minutes')
            if elapsed - notice >= 60:
                print('Shared CI: waiting for the heavy-job slot', flush=True)
                notice = elapsed
            time.sleep(0.25)


def keep(fd: int, context_fd: int, ready_fd: int) -> None:
    with os.fdopen(context_fd) as stream:
        context = json.load(stream)
    try:
        worker = context['worker']
        pidfd = os.pidfd_open(worker['pid'])
        try:
            if not same_process(worker):
                raise RuntimeError('Worker exited during slot handoff')
            poll = select.poll()
            poll.register(pidfd, select.POLLIN)
            write_state(context, 'holding', 'worker')
            os.write(ready_fd, b'1')
            os.close(ready_fd)
            poll.poll()  # Hold through all post steps and Runner.Worker cleanup.
            if marker_processes(context):
                # Unexpected children after Worker cleanup require a frozen root
                # inspection, even if they subsequently exit on their own.
                write_state(context, 'incident', 'orphaned-payload')
                return
            write_state(context, 'released', 'complete')
        finally:
            os.close(pidfd)
    except BaseException:
        write_state(context, 'incident', 'keeper-failed')
        raise
    finally:
        os.close(fd)


def start_keeper(fd: int, context: dict) -> None:
    context_r, context_w = os.pipe()
    ready_r, ready_w = os.pipe()
    child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'keep',
                              '--lock-fd', str(fd), '--context-fd', str(context_r), '--ready-fd', str(ready_w)],
                             pass_fds=(fd, context_r, ready_w), start_new_session=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    os.close(context_r)
    os.close(ready_w)
    try:
        with os.fdopen(context_w, 'w') as stream:
            json.dump(context, stream)
        if not select.select([ready_r], [], [], 10)[0] or os.read(ready_r, 1) != b'1':
            raise RuntimeError('CI slot keeper did not acknowledge ownership')
    except BaseException:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=10)
        raise
    finally:
        os.close(ready_r)


def hook() -> None:
    context = worker_context()
    if (context['repository'], context['workflow'], context['job']) in LIGHT:
        print('Shared CI: lightweight job, heavy slot not required', flush=True)
        return
    fd = open_lock()
    try:
        acquire(fd)
        start_keeper(fd, context)
        print('Shared CI: heavy-job slot acquired', flush=True)
    finally:
        os.close(fd)  # The independently exec'ed keeper retains the open description.


def budget_module():
    path = Path(__file__).with_name('shared-ci-budget.py')
    if not path.is_file():
        path = Path('/usr/local/sbin/shared-ci-budget')
    loader = importlib.machinery.SourceFileLoader('shared_budget', str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def runtime_values(unit: str) -> tuple[int, list[bytes]]:
    module = budget_module()
    pid = int(module.properties(unit)['MainPID'])
    if not pid:
        return 0, []
    values = (PROC / str(pid) / 'environ').read_bytes().split(b'\0')
    return pid, values


def runtime_uses_hook(unit: str) -> bool:
    return b'ACTIONS_RUNNER_HOOK_JOB_STARTED=' + str(HOOK).encode() in runtime_values(unit)[1]


def runtime_enabled(unit: str) -> bool:
    pid, values = runtime_values(unit)
    if not pid:
        return False
    groups = next(line.split()[1:] for line in (PROC / str(pid) / 'status').read_text().splitlines()
                  if line.startswith('Groups:'))
    return (b'ACTIONS_RUNNER_HOOK_JOB_STARTED=' + str(HOOK).encode() in values
            and b'SHARED_CI_QUEUE_UNIT=' + unit.encode() in values
            and str(grp.getgrnam(GROUP).gr_gid) in groups)


def installed_files() -> dict[Path, bytes]:
    wrapper = '#!/bin/sh\nexec /usr/bin/python3 ' + str(LIBRARY)
    files = {LIBRARY: Path(__file__).read_bytes(), HOOK: (wrapper + ' hook\n').encode(),
             OPERATOR: (wrapper + ' "$@"\n').encode()}
    lines = [f'd {ROOT} 0755 root root -', f'f {ROOT}/slot.lock 0640 root {GROUP} -']
    for unit, (user, _) in RUNNERS.items():
        files[SYSTEMD / f'{unit}.d/95-shared-ci-queue.conf'] = (
            f'[Service]\nSupplementaryGroups={GROUP}\n'
            f'Environment="ACTIONS_RUNNER_HOOK_JOB_STARTED={HOOK}"\n'
            f'Environment="SHARED_CI_QUEUE_UNIT={unit}"\n').encode()
        lines.append(f'd {ROOT}/{unit} 2750 {user} {GROUP} -')
    files[TMPFILES] = ('\n'.join(lines) + '\n').encode()
    return files


def require_host_root() -> None:
    if os.geteuid() != 0 or socket.gethostname() != 'gmk-prod-1' or not hasattr(os, 'pidfd_open'):
        raise RuntimeError('Operator requires root on gmk-prod-1 with Linux pidfd support')


def install(backup: Path) -> dict:
    module = budget_module()
    module.preflight()
    if any(not module.in_target(module.properties(u), module.SLICE) for u in module.UNITS):
        raise RuntimeError('The existing shared CI budget must be fully applied first')
    if backup.parent != BACKUPS or not backup.name.startswith('shared-ci-queue-') or backup.exists():
        raise RuntimeError('Use a fresh /var/backups/shared-ci-queue-* directory')
    files = installed_files()
    if ROOT.exists() or any(p.exists() or p.is_symlink() for p in files):
        raise RuntimeError('Queue paths already exist; inspect instead of overwriting')
    try:
        grp.getgrnam(GROUP)
        raise RuntimeError('Queue group already exists; inspect its access first')
    except KeyError:
        pass
    for unit, (user, _) in RUNNERS.items():
        text = module.run('systemctl', 'show', unit, '-p', 'User', '-p', 'Environment')
        props = dict(line.split('=', 1) for line in text.splitlines())
        if props['User'] != user or any(v.startswith('ACTIONS_RUNNER_HOOK_') for v in shlex.split(props['Environment'])):
            raise RuntimeError('Unexpected runner identity or preexisting hook: ' + unit)
        directory = Path(module.run('systemctl', 'show', unit, '-p', 'WorkingDirectory', '--value'))
        if any(line.startswith('ACTIONS_RUNNER_HOOK_') for line in (directory / '.env').read_text().splitlines()):
            raise RuntimeError('Existing runner .env hook must be preserved')
    backup.mkdir(mode=0o700)
    saved = {'files': {str(p): module.digest(v) for p, v in files.items()}, 'created_at': now()}
    module.atomic_write(backup / 'manifest.json', json.dumps(saved, indent=2).encode(), 0o600)
    module.run('groupadd', '--system', GROUP)
    try:
        for path, value in files.items():
            module.atomic_write(path, value, 0o755 if path in (LIBRARY, HOOK, OPERATOR) else 0o644)
        module.run('systemd-tmpfiles', '--create', str(TMPFILES))
        module.run('systemd-analyze', 'verify', *RUNNERS)
        module.run('systemctl', 'daemon-reload')
    except BaseException:
        # No listener was restarted: remove only our unchanged configuration.
        # Keep the backup, group and any runtime evidence for explicit inspection.
        for path, value in files.items():
            if path.is_file() and not path.is_symlink() and module.digest(path.read_bytes()) == module.digest(value):
                path.unlink()
        module.run('systemctl', 'daemon-reload')
        raise
    return {'installed': True, 'backup': str(backup), 'activation': 'pending; reconcile idle listeners'}


def reconcile(enabled: bool = True) -> dict:
    module = budget_module()
    if any(not module.in_target(module.properties(u), module.SLICE) for u in module.UNITS):
        raise RuntimeError('Restore the verified shared CI budget before listener activation')
    restart, blocked = [], []
    for unit in RUNNERS:
        if (runtime_enabled(unit) if enabled else not runtime_uses_hook(unit)):
            continue
        lease = load_state(unit)
        if lease and lease['status'] != 'released':
            blocked.append({'unit': unit, 'reason': 'holding or incident lease; preserve worker/descendants'})
        else:
            restart.append(unit)
    result = module.reconcile(restart_units=tuple(restart))
    result['pending'].extend(blocked)
    return result


def recover(unit: str) -> dict:
    if unit not in RUNNERS:
        raise RuntimeError('Recovery is restricted to managed CI units')
    fd = open_lock()
    module, frozen = budget_module(), False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = module.properties(unit)
        if state.get('FreezerState') not in ('running', 'none', ''):
            raise RuntimeError('Unit is already frozen; preserve another maintenance operation')
        if state.get('ActiveState') == 'active':
            frozen = True
            module.run('systemctl', 'freeze', unit)
        context = load_state(unit)
        if context and (same_process(context['worker']) or marker_processes(context)):
            raise RuntimeError('Worker or tracked descendants still exist; lease preserved')
        if context:
            write_state(context, 'released', 'operator-verified')
        return {'recovered': unit}
    finally:
        try:
            if frozen:
                module.run('systemctl', 'thaw', unit)
        finally:
            os.close(fd)


def rollback(backup: Path) -> dict:
    module = budget_module()
    if backup.parent != BACKUPS or not backup.name.startswith('shared-ci-queue-') or backup.is_symlink():
        raise RuntimeError('Unexpected backup path')
    saved = json.loads((backup / 'manifest.json').read_text())
    expected = installed_files()
    if set(saved['files']) != {str(p) for p in expected}:
        raise RuntimeError('Unexpected rollback manifest')
    for path in expected:
        if path.is_symlink() or (path.exists() and module.digest(path.read_bytes()) != saved['files'][str(path)]):
            raise RuntimeError('Managed queue file changed; preserve it: ' + str(path))
    for path in expected:
        if path.parent.parent == SYSTEMD:
            path.unlink(missing_ok=True)
    module.run('systemctl', 'daemon-reload')
    result = reconcile(enabled=False)
    if not result['pending'] and not any(runtime_uses_hook(u) for u in RUNNERS):
        check_latches()
        for path in expected:
            path.unlink(missing_ok=True)
        result['queue_files_removed'] = True
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['hook', 'keep', 'install', 'reconcile', 'status', 'recover', 'rollback'])
    parser.add_argument('--backup', type=Path)
    parser.add_argument('--unit', choices=list(RUNNERS))
    for name in ['lock-fd', 'context-fd', 'ready-fd']:
        parser.add_argument('--' + name, type=int)
    args = parser.parse_args()
    if args.action == 'hook':
        hook()
        return
    if args.action == 'keep':
        keep(args.lock_fd, args.context_fd, args.ready_fd)
        return
    require_host_root()
    if args.action in ('install', 'rollback') and not args.backup:
        parser.error('--backup required')
    if args.action == 'install':
        result = install(args.backup)
    elif args.action == 'reconcile':
        result = reconcile()
    elif args.action == 'rollback':
        result = rollback(args.backup)
    elif args.action == 'recover':
        if not args.unit:
            parser.error('--unit required')
        result = recover(args.unit)
    else:
        result = {'runtime_enabled': {u: runtime_enabled(u) for u in RUNNERS},
                  'leases': {u: {k: v for k, v in (load_state(u) or {}).items() if k != 'tracking_id'} for u in RUNNERS}}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
