# Shared project workflows

Read only matching sections. Current project procedures supersede these
defaults; global instructions own command meanings and existing authorization.

## Task scope

Keep the one-developer workflow small while preserving version control, CI,
rollback, and production smoke. Default lanes are:

- `fast`: copy, CSS, small route-local UI, small PHP/JS fixes, or docs.
- `normal`: ordinary feature work with local smoke.
- `risk`: DB/schema/data, auth/session/CSRF, secrets, deploy/CI/runners,
  production infrastructure, payments/finance integrity, health/private data,
  or training/session persistence.

Projects may define different lane names and stricter operation-based criteria.
Use existing project wrappers; `make ship` and `make ship-risk` apply only where
the project actually exposes them. `make ship` is for fast/normal work; risk work
uses `make ship-risk` or the project's risk wrapper. A route displaying sensitive
information is not by itself a data-handling change.

When the task benefits from delegation, use up to three subagents with
nonoverlapping edits. Integrate their work and perform the final verification
yourself.

## Delivery

Default production flow is branch → local check → PR → CI → merge → deploy →
smoke. Production deploys remain project-specific. Server-first projects follow
their own branch, verification, and committed-main rules; server-first does not
authorize uncommitted edits to a running release.

Use the global Release workflow for "сделай пр", "закрой", "заверши задачу",
explicit limits, and status questions. It owns authorization semantics; preserve
the project's risk safeguards and required checks.

Local pre-production is the default. Remote staging is outside that default;
rebuilding it requires an explicit project decision. Legacy staging topology or
command examples do not authorize new staging operations.

A production wrapper should report project, version, commit SHA, deploy run or
command ID, health/smoke result, and rollback target. Keep deployment queues
serialized without mid-flight cancellation. Check whether the SHA is still
current `origin/main` before expensive work and immediately before switching
releases; stale jobs exit successfully as skipped. Identify the intended deploy
run by expected head SHA rather than creation time alone. Retry post-switch
health/smoke checks before rollback.

Keep version/changelog work proportional. A safe micro-fix may use the project's
automatic patch bump and short generated entry; risky or product-visible releases
may need a fuller manual entry. Version ceremony alone does not block micro-fixes.

## Closeout

Finish the local tail after merge/production smoke unless work is protected or
the owner asks to keep it. Establish evidence in order:

1. The PR is merged, or the owner explicitly abandoned the task.
2. `origin/main` contains the work by ancestry or patch equivalence; for example,
   `git cherry` has no `+` task commits.
3. If shipped, the project's production status source or safe wrapper confirms
   that the deployed SHA includes the work.
4. The worktree is clean, or dirty files are explicitly recorded as protected
   follow-up work.
5. Remove eligible task worktrees through `git worktree remove`; delete the
   local task branch with safe `git branch -d`. Forced deletion requires
   merged-PR or patch-equivalence evidence that the contents are preserved.
6. Close the usage ledger/task status when the project has a wrapper.

An absent upstream, closed PR, or missing remote branch alone is insufficient
deletion evidence. Preserve dirty, current, detached-with-unique-commits,
open-PR, protected, staging-only, and owner-kept worktrees.

## Backups

Before backup changes, use
`/Users/valentinbarko/WORK/trenervkarmane/ops/backup-policy/projects.json` and
`/Users/valentinbarko/WORK/trenervkarmane/docs/runbooks/yandex-disk-server-backups.md`.
They own verified local generations, freshness checks, restore drills, and
Yandex Disk long-term backup. Retired cross-VPS backup mirrors are not recreated
by routine cleanup. Keep deletion evidence and evidence-only `offsite-sync`
separate from backup cleanup.
