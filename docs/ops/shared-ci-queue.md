# Shared heavy CI admission on the current VPS

The four existing repository listeners keep their identities, work directories,
labels, unprivileged users and workflow steps. A root-installed STARTED hook
admits one heavy job across all four listeners. Production deploy is not hooked.
The existing two-core/3 GiB high/4 GiB maximum shared cgroup budget stays in force.

Only the exact `vbclub-training / CI / classify` and
`telovporiadke / Site placeholder / validate` combinations bypass the heavy
slot. New or renamed jobs default to heavy. This is not a FIFO scheduler.
Waiting happens in the runner hook, so GitHub shows a running job with a
waiting message, not necessarily a queued workflow. The wait is bounded to
30 minutes; an expired wait fails before the normal steps run. Telo's job
timeout is separately increased to 75 minutes to accommodate the wait,
its previous 40-minute budget and a five-minute margin.

## Lifetime and failure policy

The hook finds its actual Runner.Worker ancestor and verifies its user,
repository and service cgroup. It takes `flock` on a precreated root-owned
inode, checks incident records, then transfers the open description to a tiny
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
waiting hook overwrites the earlier holder's record. This favors safety over
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
eight managed files removed. The shared cgroup budget remains installed. The
empty dedicated group and runtime evidence are retained until an inspected
cleanup/reboot; they grant no access to application state.

## Verification

```sh
rtk proxy python3 -B -m unittest discover -s test/ops -p 'test_*.py' -v
```

Also replay the real Linux fixture: actual processes, flock, pidfd, both CI UIDs,
cancellation while waiting, abrupt Worker/keeper death, orphan incident latching,
same-unit waiting without state overwrite, group permissions and frozen recovery.
Fixtures use separate transient units, tiny CPU/memory budgets and private
temporary storage. They do not mutate production runner units, labels or secrets.
Preserve their evidence and remove only their owned units, processes and group.
