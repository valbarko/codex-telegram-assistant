# Weekly Codex Analytics Review

This is the shared Sunday analytics standard for Valentin's production
projects. It combines two signals:

- workflow friction: command classes, raw-command patterns, PR/CI overhead,
  wrappers, toolbelt gaps, Graphify navigation hints;
- usage ledger: task usage, stale work, closeout quality, manual minutes,
  missing metadata, and unresolved task tails.

Run the review separately for each production project, then produce one short
cross-project summary.

## Schedule

- Weekly on Sunday at 05:00 local time.
- Read-only for tracked project state by default.
- No commits, deploys, DB writes, migrations, GitHub mutations, Graphify
  extract/install, production or staging mutations.
- Local ignored analytics artifacts may be written only under
  `tmp/codex-task-usage`, `tmp/codex-workflow-journal`, `graphify-out`, and
  `.graphify-cache`.

## Projects

```text
TVK: /Users/valentinbarko/WORK/trenervkarmane
GMK active root/data checkout: /Users/valentinbarko/WORK/gde-moi-klienty
GMK analytics code checkout: an existing clean checkout of that repository
Shared rules: /Users/valentinbarko/WORK/valentin-rules
```

Analyze TVK and GMK as separate sections even when one project is missing a
tool. Missing tooling is a finding, not a reason to silently skip the project.

GMK's active root checkout may have parallel work in progress. Discover an
existing clean checkout with `git worktree list`; verify its repository, clean
state, and intended `origin/main` baseline before running analytics code there.
Do not create, switch, reset, or clean a checkout inside the weekly review.
If none is available, report the limitation and complete the remaining read-only
checks. Read root-local usage data with:

```bash
CODEX_TASK_USAGE_DIR=/Users/valentinbarko/WORK/gde-moi-klienty/tmp/codex-task-usage
CODEX_WORKFLOW_JOURNAL_DIR=/Users/valentinbarko/WORK/gde-moi-klienty/tmp/codex-workflow-journal
```

## Per-Project Checks

For each project:

1. Identify project state:
   - current branch and short SHA;
   - dirty/untracked state;
   - whether the expected analytics scripts exist.
2. Usage ledger, when available:
   - `php scripts/codex-task-usage.php report --days=7 --out=tmp/codex-task-usage/weekly.html --include-events`
   - `php scripts/codex-task-usage.php audit --days=7 --out=tmp/codex-task-usage/weekly-audit.md`
   - `php scripts/codex-task-usage.php stale-report --days=0 --limit=40 --out=tmp/codex-task-usage/weekly-stale.md`
3. Workflow journal, when available:
   - `php scripts/codex-workflow-journal.php report --days=7 --out=tmp/codex-workflow-journal/weekly.md`
4. Workflow friction, when available:
   - `php scripts/codex-workflow-friction-report.php --days=7`
5. Graphify, when available:
   - `php scripts/graphify-local.php status --json`
   - `php scripts/ai/iyb-ai.php graph:status --json`
   - if `graphify-out/graph.json` exists, use read-only graph queries only when
     they help explain codebase hotspots or stale integration risk.

If a command is unavailable in a project, report it explicitly:

```text
Analytics tooling gap: <script or command> is not present in <project>.
```

Do not install, generate, or repair tooling inside the weekly review.

## Output

Return a concise human report in Russian:

1. `TVK summary` - 3-7 bullets.
2. `GMK summary` - 3-7 bullets.
3. `Cross-project summary` - 3-7 bullets comparing the two projects.
4. `P0/P1 next actions` - only the highest-impact wrapper, skill, docs, or
   automation improvements.

Keep raw logs out of the response. Include numbers and dates when useful, but
prefer short conclusions over command transcripts.
