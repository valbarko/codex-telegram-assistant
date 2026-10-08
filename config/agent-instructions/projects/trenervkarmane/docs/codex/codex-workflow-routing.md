# Codex Workflow Routing

This document holds the operational routing detail that should not live in the
root `AGENTS.md`. Keep `AGENTS.md` as a dispatcher; put lane-specific detail in
skills and wrappers.

## Target Structure

- `AGENTS.md` — short dispatcher: invariants, hard boundaries, lane routing,
  and links.
- `.agents/skills/<lane>/SKILL.md` — lane behavior loaded only when relevant.
- `scripts/codex-*-task.sh` — full workflows.
- `scripts/codex-tiny-*.sh` — tiny lane shortcuts.
- `docs/runbooks/codex-task-usage.md` — analytics fields and dashboard reading.
- Deploy and DB details remain in their existing runbooks.

## CodeGraph Research Routing

TVK keeps one ignored, detached research checkout at:

```bash
CODEGRAPH_PATH=/Users/valentinbarko/WORK/trenervkarmane/tmp/worktrees/iyb-codegraph-current
```

It is the shared baseline index for fresh `origin/main`. Task worktrees should
query it explicitly instead of creating another 60+ MiB index:

Use the project wrapper so a stale or incomplete baseline fails closed before
CodeGraph returns results:

```bash
scripts/codegraph-current.sh explore "ExactSymbol or code question"
scripts/codegraph-current.sh node ExactSymbol
scripts/codegraph-current.sh callers ExactSymbol
scripts/codegraph-current.sh impact ExactSymbol
```

The wrapper performs the complete preflight. At most once per five minutes it
refreshes `origin/main` through the project GitHub gateway, then verifies that
the checkout and index exist, the checkout is clean, its `HEAD` equals the
fetched `origin/main`, and the index is complete with no pending changes:

```bash
scripts/codegraph-current.sh check
scripts/codegraph-current.sh status
```

Force an immediate network refresh and incremental index sync when diagnosing
freshness or after a known merge:

```bash
scripts/codegraph-current.sh refresh
```

Refresh and query operations share an ignored mutex under
`tmp/codegraph-current/`. A failed gateway fetch or CodeGraph sync does not
write the freshness stamp and fails closed before graph results are returned.

Usage rules from the three-day pilot:

- Use CodeGraph first for PHP/JavaScript architecture mapping, exact-symbol
  navigation, caller/callee trails, and impact exploration.
- Include an exact symbol or file name when known. Broad natural-language
  ranking is useful for orientation but is not complete enough to replace
  direct search.
- Confirm broad top-file results with `rg`. Use `rg` first for shell tooling,
  Markdown/config discovery, and dynamic/computed PHP `require`/`include`
  relationships.
- The shared index represents the `origin/main` baseline. After a task branch
  changes code, inspect the task-worktree diff and touched files directly; the
  shared graph does not contain uncommitted branch changes.
- Do not initialize `.codegraph/` in ordinary task worktrees. A dedicated
  research task may opt in explicitly when branch-local graph analysis is the
  actual deliverable.
- Keep the CodeGraph MCP server disabled by default. One-shot CLI latency is
  sufficient for normal work and avoids resident daemon/watcher cost.
- Raw `codegraph status` saying `up to date` only means the index matches that
  checkout's local files. Use the project wrapper for remote-aware freshness.
- Automatic fetches are TTL-limited; repeated graph calls inside one research
  pass use the already validated baseline without another network round trip.

## Lanes

### Tiny

Use for copy/text/grammar/label/chip/CSS, small route-local UI polish, and
small PHP/HTML view-only copy or markup changes. View-only means the diff does
not affect API payloads, DB writes, sessions, auth, training persistence,
nutrition core, or deploy behavior.

Default behavior:

- start with `scripts/codex-tiny-start.sh <slug>`;
- read only target files and narrow search output;
- do not read broad docs or `docs/codex/context-pack.md` unless target files
  cannot be located;
- do not inspect DB;
- do not use subagents;
- do not run full tests;
- remote staging is retired; staging operations require an explicit infrastructure rebuild decision;
- touch 1-3 files by default;
- check with `scripts/codex-tiny-check.sh`;
- finish with `scripts/codex-tiny-finish.sh --minutes <N> --summary "..."`
  for non-trivial work.

If the same authorized task needs DB/auth/security/training/nutrition/deploy
checks or broader visual QA, reclassify it and continue with the relevant lane
without another approval solely for that change. Leave unrelated ledger,
infrastructure and production drift outside the task. Pause only for new scope,
missing essential input or an operation that is not authorized.

### Safe

Use for small code changes with no DB/auth/security, sensitive-data handling,
training persistence, nutrition core, CI/CD, or deploy risk. A route that
displays health-like data is not automatically Risk Lane when the change is
limited to shell, layout, navigation, loading state, or lifecycle behavior and
preserves the existing data contract and handling.

Default behavior:

- start with `scripts/codex-start-task.sh <slug> --role developer --lane safe
  --delivery-path local-only --worktree`;
- read `AGENTS.md`, the relevant lane skill, and only files needed for the
  change;
- run focused checks for touched code;
- remote staging is retired. Runtime review uses the relevant local checks;
  a lane change or `--allow-safe-staging` flag does not authorize a staging
  rebuild. Reopen staging only after an explicit infrastructure decision.

### Worktree ownership

Commands with `--worktree` below assume the dispatcher checkout at
`/Users/valentinbarko/WORK/trenervkarmane`. If Codex already created the task
under `${CODEX_HOME:-$HOME/.codex}/worktrees/<id>/trenervkarmane`, reuse that
checkout and omit `--worktree`. Tiny Lane detects this automatically. Never
combine a Codex-managed task checkout with a second project-managed task
worktree. Continuing an existing branch uses a direct switch after checking its
current worktree holder; it does not run task-start again.

### Full

Use for normal features/refactors that are not tiny and are not high-risk.

Default behavior:

- use regular task start with `--lane full`;
- read `docs/codex/context-pack.md` and one relevant topical doc when needed;
- run focused local checks, commit, and push; remote staging remains retired
  unless Valentin explicitly approves a new infrastructure rebuild.

### Risk

Use for DB migrations; auth/security/privacy; changes to collection,
validation, schema, persistence, browser/offline caching or queueing,
transmission/sync, authorization, exposure, logging, export/deletion/consent,
or calculation/interpretation of health/InBody data; training
sessions/sets/history; nutrition core; CI/CD/deploy/runners; production release
flow. Classify by the operation on sensitive data, not by the route or field
name.

Default behavior:

- start with the appropriate role, semantic `--topic`, and one or more
  changed-path `--guard-scope` values, often with `--fail-real`;
- use the matching skill/runbook before edits;
- use project wrappers, never raw DB/SSH/GitHub/deploy commands;
- keep production actions gated by explicit owner intent;
- keep staging actions gated by an explicit owner-approved infrastructure rebuild;
- do not auto-merge high-risk branches without review.

Extra checks for DB-backed UI changes:

- Before changing enum-backed UI, verify the local schema and add/adjust the
  forward-only migration, `config/schema.sql`, and `docs/codex/db-reference.md`
  together.
- If a local browser smoke returns a blank page or empty 200 response, inspect
  the app log immediately before trying more UI fixes.
- Do not run multiple `playwright-smoke.sh --ensure-server` jobs against the
  same local port in parallel; run them sequentially to avoid false failures.
- Add at least one persistence smoke for the edge case that motivated the
  change, not only a visual/open-panel smoke.

### Review-Only

Use for analysis without writes.

Default behavior:

- role `reviewer` or `code-researcher`;
- no edits, commits, DB writes, deploys, or staging mutation;
- findings first for reviews;
- mention test gaps and residual risk.

### Staging Preview

This lane is retired. Do not deploy, reconcile, reset, seed, migrate or mutate
staging unless Valentin explicitly approves a new infrastructure rebuild.
A request for ordinary visual QA or a lane flag does not reopen it.

After that decision, read current state before claiming it and use the approved
`scripts/staging-ops.sh` procedure. Preserve any live preview; a replacement
needs an explicit scope and reason.

## Example Commands

Tiny:

```bash
cd /Users/valentinbarko/WORK/trenervkarmane && scripts/codex-tiny-start.sh profile-copy
cd /Users/valentinbarko/WORK/trenervkarmane/tmp/worktrees/iyb-profile-copy
scripts/codex-tiny-check.sh
scripts/codex-tiny-finish.sh --minutes 6 --summary "polished profile copy"
```

Safe:

```bash
cd /Users/valentinbarko/WORK/trenervkarmane && scripts/codex-start-task.sh admin-filter-fix --role developer --lane safe --delivery-path local-only --worktree
```

Full:

```bash
cd /Users/valentinbarko/WORK/trenervkarmane && scripts/codex-start-task.sh dashboard-refactor --role developer --lane full --delivery-path local-only --worktree
```

Risk:

```bash
cd /Users/valentinbarko/WORK/trenervkarmane && scripts/codex-start-task.sh training-session-migration --role data-migration --lane risk --delivery-path no-deploy --topic training --guard-scope training --fail-real --worktree
```

Review-only:

```bash
cd /Users/valentinbarko/WORK/trenervkarmane && scripts/codex-start-task.sh review-admin-flow --role reviewer --lane review-only --delivery-path no-deploy --worktree
```

Staging preview, only after an explicitly approved infrastructure rebuild:

```bash
scripts/staging-ops.sh status --json
scripts/staging-ops.sh --approved-staging land codex/my-branch
```

## Final Reports

Tiny final report:

- lane;
- changed files;
- checks;
- branch/commit;
- blockers only if real.

Safe/full/risk reports may include staging, PR, migration, production, and
residual risk sections when those surfaces were actually touched.
