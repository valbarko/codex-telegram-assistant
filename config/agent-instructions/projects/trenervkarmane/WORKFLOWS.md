# TVK task and operations workflows

Read the matching branch before acting. Paths resolve from the TVK repository
root; execute wrappers in the selected task checkout. Wrappers/safety gates remain
authoritative; use `rtk proxy` when exact raw output is required.

## Task start and continuation

New implementation starts from fresh `origin/main` on `codex/<slug>`. Continue an
old branch only when Valentin explicitly says so, using its existing worktree.
From the dispatcher root, use `scripts/codex-start-task.sh <slug> --role <role>
--worktree` or `scripts/codex-tiny-start.sh <slug>` for tiny UI/copy. Roles are
architect/developer/reviewer/infra/data-migration/code-researcher as appropriate.

Project-created worktrees/scratch clones belong in ignored `tmp/worktrees/`, not
sibling `~/Downloads` directories. Reuse a Codex-managed task checkout and omit
`--worktree`; never create a second sandbox for it. Tools that change working
directory need an explicit repository `cd` prefix. Usage-lane labels may include
tiny/safe/batch/full/infra/research/unknown; state their mapping when it matters.
Delivery paths are local-only/docs-only/prod/no-deploy, not retired remote staging.

## Local runtime, DB and browser operations

Use the raw-command-quarantine and preview procedures in
`docs/runbooks/codex-toolbelt.md` before choosing tooling.
TVK `http://127.0.0.1:8080` is on demand: browser wrappers or
`scripts/start-local-server.sh --ensure 8080`. Keep warm GMK `:8081` and local
MySQL `:3307`; do not start Docker or stop persistent services for routine QA.

Phone/worktree previews use `scripts/start-local-preview-server.sh <port> 10800
<label>` through the shared `com.valentin.local-preview.supervisor`, with a
three-hour TTL. No ad-hoc background server or task-specific LaunchAgent.
Use project DB wrappers from the first attempt: `scripts/local-db-ops.sh`,
`scripts/local-readonly-probe.php`, `scripts/local-db-readonly.php`, or
`scripts/local-db-write.php`; do not improvise PHP DB diagnostics around db.php.
Use project Playwright wrappers for browser QA and `scripts/github-gateway.sh`
or `scripts/gh-actions-readonly.sh` for GitHub API/PR/Actions.

## Production and incidents

Production source is merged `main`, path `/srv/inyourbody`. Before release or DB
operations read `docs/runbooks/deploy.md`, `docs/runbooks/db-migration.md`, and the
matching production/release skill. Production intent uses `scripts/release-prod.sh`
or `scripts/prod-ops.sh`; do not bypass them with raw DB/SSH/GitHub/deploy commands.
Never copy ignored secrets such as `config/db.php`.

Remote staging is retired. Do not deploy/reconcile/reset/seed/migrate/mutate it
unless Valentin explicitly approves a new staging infrastructure rebuild; only
then use `scripts/staging-ops.sh`. Telegram operator reports/postmortems use the
approved MarkdownV2 wrapper and `docs/runbooks/incident-hotfix.md`, not raw SSH or
another parse mode.

## Minor program-data edits

An explicit production request for a small existing-program data edit authorizes
`scripts/prod-ops.sh --approved program-data-set ...`, one exact target ID and one
field per call. Verify structured before/after evidence. Allowed: program/day
text, sets/reps/rest, coach comments, hiding an existing program from self-selection.
The scoped data edit needs no migration/PR/deploy/VERSION/changelog ceremony and
no second confirmation for the same operation.

Use admin/migration/training-core/release flow for catalog publication or enabling
self-selection, other status/visibility/ownership/system identity, new programs,
exercise substitution/addition/removal/reorder, day structure, assignments, bulk
edits, schema, deletes or workout session/set/history rows. Never use arbitrary
production SQL for this shortcut.

## AI credential diagnosis

Upstream OpenAI credentials, including speech-to-text, live only on VPS3 in
`/etc/inyourbody/ai-bridge.env`. TVK stores only bridge URL/shared secret/pinned TLS;
do not copy `OPENAI_API_KEY` into a repository, worktree or local configuration.
Before reporting it missing, use a sanitized boolean existence/status check via
`scripts/project-ssh.sh vps3` and verify `inyourbody-ai-bridge.service` is active.
Never return or print the key, including unguarded grep/output.

## Store artifacts and runtime parity

Current release constraints: iOS external TestFlight is the rollout focus; Android
RC4 and its pending RuStore moderation entry are frozen. Do not replace, rebuild,
upload or mutate that entry. Owner-approved cross-wrapper work may change Android
source as a separately versioned post-RC4 candidate. Shared UI/copy/web-runtime
changes apply to both wrappers; OS forks require a concrete native reason/parity
record. Remote Push/launcher badges wait for RC4 approval and an owner-opened
provider task; provider-independent local notifications/permission/status bridges
may progress in the post-RC4 candidate without touching the moderation artifact.

After both public mobile releases, standalone/installable PWA retirement still
requires a separate audited project and explicit command. It never implicitly
removes PHP routes/backend/shared shell/partial-screen contracts required by stores.

## PR, release and closeout

Before PR, production promotion or broad/high-risk push, run
`scripts/codex-branch-guard.sh --before-pr` with path allowlists when useful.
`codex/**` pushes may run CI but never deploy; high-risk merge needs explicit
review/approval within the task's existing authorization.
Use matching shared WORKFLOWS release/cleanup sections and
`docs/runbooks/codex-toolbelt.md` for preservation evidence and safe local cleanup.

Global command meanings apply: `сделай пр` creates a draft; `закрой` /
`сделай пр и закрой` includes supported production flow unless limited. Reuse the
same authorization while keeping checks/risk safeguards. `закрыто?` / `закрыто`
after implementation/production/data work asks for state inspection and any safe
missing Git tail; stop before high-risk merge or failing required checks. `на прод`,
prod/production/deploy or equivalent is production intent, followed by local Git
closeout after verified production. Never delete dirty, unpreserved, protected,
open-PR or owner-kept work.

Before final response for nontrivial implementation/review/deploy, record usage via
`scripts/codex-finish-task.sh --minutes <N> --summary "..."`; tiny work prefers
`scripts/codex-tiny-finish.sh`. Final implementation status is local only, pushed
branch, PR pending, merged to origin/main, deployed to production, or abandoned.
