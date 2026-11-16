# Telo CI light runner

The repository has a dedicated runner for the `check / plan` job:
`gmk-val-ci-telo-light`, labels `self-hosted, Linux, X64, telo-ci-light`.
It has **no `val-ci` label**. The existing Telo runner executes the heavy job.
Planning, exact-source CI reuse and dependency-free quick checks can therefore
finish while a heavy Telo job occupies its separate repository runner.

The light runner uses its own `telo-ci-light` system user, home at
`/var/lib/telo-ci-light`, installation/work directory at
`/opt/actions-runner-val-ci/telo-light`, and the versioned
`infra/telo-ci-light.service`. Start the official `runsvc.sh` entrypoint; do not
add a second `run.sh` process for the same registration.

## Resource and access boundary

The service is inside the existing `system-valci.slice`, so the aggregate CI
limit stays **2 CPU / 4 GiB**. Its own limit is 50% CPU, 384 MiB memory high,
512 MiB maximum and 128 tasks. It does not use a heavy-job lease: its distinct
label and the workflow's bounded light plan restrict its role. npm/Composer
installation, PHP/SQL suites, TypeScript compilation and other heavy plans go
to `[self-hosted, val-ci]` and the two shared heavy slots.

No test database environment, production settings, SSH keys or Docker access
are copied. The new user is not in existing CI/database groups. The service
hides production paths, database sockets/configuration and Docker's socket;
protects home/system paths; and denies loopback IP traffic except Ubuntu's
DNS stub at `127.0.0.53`. It still needs outbound HTTPS to GitHub. The DNS stub
exception is not a database credential or Unix socket grant.

## Install

After review and merge, check host `gmk-prod-1`, the shared slice limits,
available disk space, and that the user, service, directory and runner name do
not already exist. Create only the new system user/home and private installation.
Reuse a verified installed GitHub runner distribution on this host by copying
only resolved `bin`, `externals` and the normal root-level launcher scripts;
never copy `.runner`, `.credentials*`, `.env`, `.path`, `_work` or `_diag`.
Record the binary version/hash. A fresh official release archive with verified
checksum is an alternative.

Request a fresh registration token for `valbarko/telovporiadke`. Keep the
response in memory and send it over the existing authorized SSH connection's
stdin. Run configuration as the new user, with
`ACTIONS_RUNNER_INPUT_TOKEN` in its process environment, `--unattended`, the
repository URL, exact runner name, `--labels telo-ci-light` and `--work _work`.
The runner supports and masks this environment input. Never echo the token,
put it in an argument, save it to a file or copy an existing registration.

Install the merged service file, validate with `systemd-analyze verify`, reload
systemd, then enable/start only this new service. Record the registration ID
and committed service SHA-256 in a private deployment receipt. Confirm exactly
one listener for this registration, GitHub online status, labels, effective
slice/hardening and a real `plan` job. Verify ordinary heavy work still uses the
existing runner and shared slots, and smoke the hosted sites.

## Retention and rollback

The installation, home and small tool/source caches are service-owned retained
resources. Existing CI disk retention may be extended to this exact new path;
do not delete it as task scratch while its service or a Worker is active.
Do not remove shared caches or the existing Telo registration.

For a rollback, first route `plan` back to the existing Telo runner in the
reviewed workflow and wait for the light Worker to finish. Stop/disable the
new service only, remove the exact GitHub runner registration ID, and preserve
its private credentials/diagnostics until registration removal and inactivity
are verified. Then remove only the identified service files and owned
installation/home. The heavy queue and production services stay intact.
