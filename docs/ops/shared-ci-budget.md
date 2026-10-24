# Shared production-host CI budget

`scripts/ops/shared-ci-budget.py` is a root-operated maintenance tool scoped to
`gmk-prod-1` with cgroup v2. It groups the four unprivileged CI runner services
and `tvk-ci-mysql.service` under `system-valci.slice`:

- CPU: a shared maximum of 200% (two CPU cores), weight 20.
- Memory: 3 GiB soft pressure boundary, 4 GiB hard safety ceiling.
- I/O: weight 20, effective when the host's active I/O controller/scheduler
  supports proportional weights; this is not a throughput/IOPS cap.

Existing per-service limits remain in effect. This does not remove Telo CI's
individual 1600 MiB MemoryHigh boundary. The hard ceiling is a final protection,
not a guarantee of free production memory; measured pressure and job peaks must
still be reviewed. The production deployment runner, production MySQL, PHP and
application workers remain outside this slice.

## Install and migrate

Use the reviewed, committed script after the PR is merged. Preserve its exact
source hash in the task evidence. No secrets or application releases are copied.

```sh
python3 shared-ci-budget.py status
python3 shared-ci-budget.py install --backup /var/backups/shared-ci-budget-TIMESTAMP
python3 shared-ci-budget.py reconcile
```

Install creates only six dedicated new unit/drop-in files. It refuses existing
managed paths or preexisting alternate slice assignments. The private manifest
backs up the original unit configuration/state and records installed hashes.
It verifies units before daemon-reload. Install itself does not restart services.

Reconcile freezes runner cgroups briefly for worker inspection, then immediately
thaws busy groups. A cgroup containing `Runner.Worker` is never stopped. Only an
inspected idle runner cgroup is killed atomically through kernel `cgroup.kill`
while still frozen, then stopped, started and explicitly thawed in its configured
slice. This narrow idle-only SIGKILL prevents the
listener from accepting/spawning a new worker during systemd's automatic thaw
before stop. An assigned but not yet executing GitHub job may need retry after a
listener disconnect; inspect Actions after migration. No running job is knowingly
terminated. All remaining frozen units are thawed even on inspection failure.

Before inspection, a unique temporary runtime drop-in disables automatic restart
for the listeners being migrated. Effective `Restart=no` is verified before any
freeze or kill. Cleanup removes the drop-in and reloads configuration, restoring
the original restart policy. Preexisting drain files cause a safe refusal.
Only the verified `Type=simple` listeners are supported. The kernel operation
avoids systemd255 auxiliary-process KillUnit errors; the explicit post-start thaw
also handles systemd preserving freezer state across a failed/empty unit.

The isolated test database restarts gracefully only while all four runners are
active, successfully frozen and idle. Transitional/inactive/missing states fail
closed. Busy units remain pending; repeat reconcile after they finish. This may
take multiple passes on a busy pool. Do not claim the aggregate budget covers all
CI until every active managed unit's ControlGroup is inside the slice. Preserve
inactive units' activation state; their new assignment applies on next start.

## Verify

```sh
python3 shared-ci-budget.py status
systemctl show system-valci.slice -p CPUQuotaPerSecUSec -p MemoryHigh -p MemoryMax -p IOWeight
systemctl show system-valci.slice -p MemoryCurrent -p TasksCurrent
```

Check all managed ControlGroups, every service's active/freezer state, GitHub
runner availability/job outcomes, cgroup `memory.events` and `cpu.stat`, and all
hosted sites/API health. Compare main PHP/API latency during normal CI load.
No synthetic production stress test is required. A larger Actions queue is an
expected tradeoff of limiting shared compute.

## Rollback

```sh
python3 shared-ci-budget.py rollback --backup /var/backups/shared-ci-budget-TIMESTAMP
```

Rollback removes only the six dedicated files whose hashes still match the
install manifest, reloads configuration, and moves idle units back to their
original `system.slice`. Busy units remain pending; repeat the same rollback
after completion. Existing source unit files, limits, unrelated drop-ins and
inactive activation states are preserved. A later operator edit is protected by
hash checks. Keep the private manifest until post-change verification completes.

## Local verification

```sh
python3 -B -m unittest discover -s test/ops -p 'test_*.py' -v
```

Tests cover subtree worker detection, busy/inactive/transitional handling,
ordering, protected production units, idempotent reconciliation, and thaw cleanup
after failures. Linux unit validation and live routing are separate production
checks; mocks alone do not establish actual systemd behavior.
