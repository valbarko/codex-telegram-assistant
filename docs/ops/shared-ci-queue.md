# Shared heavy CI admission on the current VPS

The four existing repository listeners keep their identities, work directories,
labels, unprivileged users and workflow steps. A root-installed STARTED hook
admits up to two heavy jobs across all four listeners. Production deploy is not hooked.
The existing two-core/3 GiB high/4 GiB maximum shared cgroup budget stays in force.

Only the exact `vbclub-training / CI / classify` and
`telovporiadke / Site placeholder / validate` combinations bypass the heavy
slot. New or renamed jobs default to heavy. This is not a FIFO scheduler.
Waiting happens in the runner hook, so GitHub shows a running job with a
waiting message, not necessarily a queued workflow. The wait is bounded to
the workflow's own timeout or cancellation. There is no separate 30-minute
queue failure. Progress includes elapsed wait once a minute. Telo's workflow
has a separate 180-minute overall guard; other workflows retain their own guards.
Repository listeners remain repository-specific: this adds cross-project
parallelism, not another listener for two simultaneous jobs in the same repository.

## Lifetime and failure policy

The hook finds its actual Runner.Worker ancestor and verifies its user,
repository and service cgroup. It takes `flock` on a precreated root-owned
inode for one of two slots, checks incident records, then transfers the open description to a tiny
independently exec'ed keeper. The hook succeeds only after the keeper has
recorded ownership and acknowledged the handoff. The keeper receives a minimal
environment without `RUNNER_TRACKING_ID`; the ordinary runner orphan cleanup
therefore does not kill it early. Job environment contents are never logged.

The keeper holds the slot through the Worker lifetime, including post steps
and cleanup, using Linux pidfd plus process start ticks. After Worker exit it
checks the service cgroup for the old job's tracking marker. The inventory must
be stable, including process start identities; unreadable processes fail closed.
If an orphan is found, the keeper leaves an incident record and releases its FD.
The record prevents subsequent heavy jobs from proceeding, even if the orphan
later exits. A keeper crash likewise leaves a nonterminal incident latch. No
waiting hook overwrites the earlier holder's record. Admission and keeper
acknowledgement are serialized by a short-lived separate `admission.lock`.
An active holder in another slot is permitted only while its slot lock is still
held. An incident, duplicate slot record or a nonterminal record with an unlocked
slot blocks new work. A missing `slot` field means the original slot 1, preserving
existing keepers during upgrade. This favors safety over
automatic recovery from an ambiguous process failure.

This coordinates trusted reviewed CI; it is not a sandbox against a malicious
workflow running as the same user. Deliberately removing process tracking or
modifying that user's lease files is outside the guarantee. The queue grants
no sudo, production secrets, Docker socket or production database access.

## Install and activate

Use the reviewed committed source, only after local tests, Linux fixtures,
independent review and merge. Install the accompanying updated
`shared-ci-budget.py` at its existing `/usr/local/sbin/shared-ci-budget` path
first; its default reconciliation is unchanged, and the additional restart
argument accepts only the four CI listeners.

The queue installer creates a dedicated empty system group, eight dedicated
files and a tmpfiles policy. No user receives persistent group membership;
only the four listener units receive `SupplementaryGroups=shared-ci-queue`.
The tmpfiles policy recreates root-owned lock storage and private per-unit
setgid state directories on boot. They are outside runner workspaces and are
not removed on a listener restart. Preexisting hooks/paths/groups cause refusal.
Runner `.env`, `.runner`, credentials, labels, ExecStart and application releases
are not modified. Installation itself does not restart listeners.

The STARTED entrypoint is `/usr/local/libexec/shared-ci-queue-hook.sh`. The
`.sh` suffix is required by the runner's script interpreter selection; a
shebang alone does not make an extensionless path acceptable to the runner.
See GitHub's [runner hook script requirements](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts).

```sh
rtk proxy ssh gmk-root python3 /var/tmp/REVIEWED-QUEUE.py install --backup /var/backups/shared-ci-queue-TIMESTAMP
rtk proxy ssh gmk-root /usr/local/sbin/shared-ci-queue reconcile
rtk proxy ssh gmk-root /usr/local/sbin/shared-ci-queue status
```

Reconcile uses the existing frozen-idle listener migration safeguards. A live
Worker, a holding/incident lease or an incomplete shared resource budget prevents
the affected restart. Busy listeners remain pending; repeat after they finish.
No application or test database restart is needed for queue activation.
Confirm actual MainPID environment and supplementary groups on every listener,
GitHub online/listening status and successful normal CI jobs before declaring
activation complete. Listener session renewal can take time after restart.

An installation failure removes only its unchanged newly installed files and
reloads systemd. Its private backup, dedicated group and runtime evidence remain
for inspection; do not erase them blindly to force a retry.

## Inspect or recover an incident

Status omits the cleanup tracking marker. Inspect the relevant Worker, service
processes and runner logs before recovery. Recovery cannot kill a Worker or an
orphan. It requires an available global lock, freezes only the allowlisted CI
service, refuses an existing unrelated freeze, verifies the original Worker and
tracked descendants are gone, records release and thaws the service in finally.
It refuses recovery while a real keeper still holds the global lock.

```sh
rtk proxy ssh gmk-root /usr/local/sbin/shared-ci-queue status
rtk proxy ssh gmk-root /usr/local/sbin/shared-ci-queue recover --unit telo-ci.service
```

Do not unlink or recreate `slot.lock`, delete a nonterminal lease, or make the
lock/world state writable. That would remove crash protection. Reboot clears
`/run` only after all old processes have died with the previous boot.

## Rollback

```sh
rtk proxy ssh gmk-root /usr/local/sbin/shared-ci-queue rollback --backup /var/backups/shared-ci-queue-TIMESTAMP
```

Rollback verifies the install hashes, removes only queue drop-ins, reloads systemd
and restarts only safely idle listeners. Busy/incident listeners remain pending
and keep the installed hook files so their next startup cannot reference a
missing executable. Repeat after completion or verified incident recovery.
Only after no listener uses the hook and every lease is terminal are the remaining
managed files removed. The shared cgroup budget remains installed. The
empty dedicated group and runtime evidence are retained until an inspected
cleanup/reboot; they grant no access to application state.

## Upgrade the existing installation and change capacity

The root-owned `/etc/shared-ci-queue-slots.json` stores `{"slots": 1}` or
`{"slots": 2}`. Missing policy defaults to one slot for a safe upgrade. It survives
reboots. `slot.lock` remains slot 1; never replace its inode while a job is active.
The additional `slot-2.lock` and `admission.lock` are root-owned `0640`, group
`shared-ci-queue`, and must also appear in the existing tmpfiles policy.

Before publishing an upgrade, verify the old installed source against the
previous committed source, back up the library, tmpfiles policy and capacity
policy in a private `/var/backups/shared-ci-queue-upgrade-*` directory, create only
the two missing lock files without replacing existing inodes, and extend the
tmpfiles policy. Atomically replace only the library with reviewed merged source.
No runner restart, database restart or application release switch is necessary.

Record hook processes by PID **and process start ticks** before and immediately
after publication. Keep capacity at one until those observed hooks have exited:
an old in-memory hook still uses the old global latch check. Existing keepers and
Workers finish normally; new hooks use the new source. Only then enable two slots.

```sh
rtk proxy ssh gmk-root /usr/local/sbin/shared-ci-queue configure --slots 2
rtk proxy ssh gmk-root /usr/local/sbin/shared-ci-queue status
# Reversible capacity rollback, without cancelling running jobs:
rtk proxy ssh gmk-root /usr/local/sbin/shared-ci-queue configure --slots 1
```

Reducing capacity prevents new slot-2 admissions; an already running job there
finishes normally. Keep the aggregate two-CPU/4-GiB budget. Check real overlap,
production HTTPS responses, CPU/memory pressure, swap activity and OOM events.
For a full code rollback, first reduce to one and wait until all heavy Workers
and hooks finish, then restore the verified backup. The older full-uninstall
manifest is tied to the older source: do not use it as a code downgrade tool.

## Disposable MySQL performance

Telo currently has 54 SQL suites and 89 migrations. Many suites independently
drop and rebuild their disposable schema. CI logs from November 16 show the SQL
stage taking 25–30 minutes, even without queue wait. Preserve account isolation,
concurrent saves/deletes, nutrition and mocked billing coverage; scope pure
mobile changes separately and report suite durations to find repeated setup.

The isolated `tvk-ci-mysql.service` is separate from production `mysql.service`.
Only on that disposable instance, `innodb_flush_log_at_trx_commit=2` can avoid
synchronous durable log flushes on every test transaction. Use its existing
private root client file; verify `@@socket=/run/tvk-ci-mysql/mysql.sock`,
`@@datadir=/var/lib/tvk-ci-mysql/` and disabled binary logging before any change.
Record the previous value, benchmark in a uniquely named disposable database,
and apply with `SET PERSIST` so it survives restarts. This accepts losing recent
**test-only** transactions during a host crash; every suite recreates its data.
Production durability, MySQL users/grants and CI memory/CPU limits stay intact.

## Verification

```sh
rtk proxy python3 -B -m unittest discover -s test/ops -p 'test_*.py' -v
rtk proxy python3 -B test/ops/run_ci_queue_linux_fixture.py --self-test
rtk proxy python3 test/ops/run_ci_queue_linux_fixture.py --source scripts/ops/shared-ci-queue.py --host gmk-root
```

Also replay the real Linux fixture: actual processes, flock, pidfd, both CI UIDs,
cancellation while waiting, two simultaneous payloads with a third waiting,
live reduction to one without cancelling Workers, abrupt Worker/keeper death, orphan incident latching,
same-unit waiting without state overwrite, group permissions and frozen recovery.
Fixtures use separate transient units, tiny CPU/memory budgets and private
temporary storage. They do not mutate production runner units, labels or secrets.
They reject an extensionless reviewed hook before allocation and execute the
fixture `.sh` entrypoint with `bash -e`, matching the runner's shell invocation.
This fixture does not replace the final successful job through the real runner.
Preserve their evidence and remove only their owned units, processes and group.
The executable fixture copy is staged under `/var/lib` because `/run` is
mounted noexec on this host. Evidence defaults to `.private/reports/ci-queue-linux`
and can be directed outside the task checkout with `--output` before closeout.
