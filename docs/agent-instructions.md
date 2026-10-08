# Agent instruction structure

This one PR versions Valentin's global, shared and project instruction sources.
The manifest maps 38 files to local targets on his Mac: global/shared rules,
14 project AGENTS files, their references, and existing runbook/template
updates. Opening or merging the PR alone does not activate the external targets.
The installer applies the reviewed bundle separately; no application deployment
or production-server operation is part of this migration.

## Three increasingly radical passes

| Pass | Proposal | Outcome |
| --- | --- | --- |
| 1 — conservative | Move long sections intact behind links; retain most wording. | Preserves rules, but also preserves duplicated source material and too many reference files. |
| 2 — structural | Separate code, authoring, and non-code workflows; give every reference an explicit trigger. | Adopted as the file boundaries. |
| 3 — radical | Replace copies of canonical policies with pointers; remove eager RTK import and environment caches. | Adopted where a verified source already owns the rule. Owner-specific guardrails remain explicit. |

The same three subagents audited both levels, then the other projects. They
implemented disjoint source folders and cross-reviewed coverage and installation.
The final structure combines the second pass's task boundaries with the third
pass's pruning; it is one implementation, not three competing PRs. The installed
`writing-for-agents` skill supplies the pointer/disclosure/pruning method.

## File ownership

| Source | Scope and load condition |
| --- | --- |
| [../AGENTS.md](../AGENTS.md) | Automatically loaded repository router. |
| [../CODING_STANDARDS.md](../CODING_STANDARDS.md) | Project code changes/review; points to existing product contracts and configured commands. |
| [../writing/AGENT_WRITING.md](../writing/AGENT_WRITING.md) | New authorial work/substantial rewrites; retrieval and private-input handling. |
| [../config/agent-instructions/AGENTS.global.md](../config/agent-instructions/AGENTS.global.md) | Source for `~/.codex/AGENTS.md`; global router and universal owner overrides. |
| [../config/agent-instructions/CODING_STANDARDS.md](../config/agent-instructions/CODING_STANDARDS.md) | Source for `~/.codex/agent-instructions/CODING_STANDARDS.md`; code, copy, UI, browser, LAN, CodeGraph, and shared-host branches. |
| [../config/agent-instructions/WORKFLOWS.md](../config/agent-instructions/WORKFLOWS.md) | Source for `~/.codex/agent-instructions/WORKFLOWS.md`; completion, release, artifacts, memory, evidence, and tools. |

Shared sources live in `config/agent-instructions/shared/`; project sources in
`config/agent-instructions/projects/<project>/`.
`AGENTS.global.md` and `AGENTS.project.md` are deliberately not named `AGENTS.md`
in the source bundle: templates must not become directory-scoped instructions.
Read referenced sections only when their trigger fires. Do not import either
CODING_STANDARDS or WORKFLOWS unconditionally.

## Migration map

| Previous material | Authoritative destination |
| --- | --- |
| Task completion, long-task checkpoints, narrow follow-ups | Global WORKFLOWS — Completion. |
| Finished artifacts and source consistency | Global WORKFLOWS — Artifacts. |
| User-facing copy and failure messages | Global CODING_STANDARDS — User-facing copy. |
| No automatic previews; silent preservation of unrelated changes | Global AGENTS, kept inline because they apply across branches. |
| Browser choice and project-local duplicate | One pointer to the existing shared browser policy. |
| Playwright version compatibility; LAN preview lifetime | Global CODING_STANDARDS — Browser use and checks; Phone previews. |
| “сделай пр”/“закрой”/“заверши задачу” and status-question distinction | Global WORKFLOWS — Release. |
| Curated memory and lengthy advisory/project-evaluation copies | Global WORKFLOWS — Memory and advice, then canonical local profiles. |
| Interface skill routing | Existing mobile-interface-skills policy. |
| Typography source/render and code-file protection | Existing russian-typography skill. |
| CodeGraph navigation | Global CODING_STANDARDS — Indexed-code exploration; MCP policy remains in RTK. |
| Marketing workflow and local project duplicate | Installed valentin-content-marketing skill, which owns the local playbook/template pointers. |
| RTK eager import | Inline shell prefix; conditional RTK pointers for evidence/MCP; direct canonical proxy/SEO pointers. |
| Authorial source priority, modes, one draft/one edit, latest corrections, rewrite limits | Existing tracked VALENTIN_STYLE.md. |
| Gold selection, provenance path, channel selection, sequential Milvus searches | Project AGENT_WRITING; private inputs remain local. |
| Repeated search commands and tool configuration | package.json, configuration, and CLI help. Only the sequential-search gotcha stays documented. |

Removed from the always-loaded layer: generic “verify facts”/“synthesize style”
restatements already covered by the authorial source; repeated browser, marketing,
SEO, typography, and advisory procedures; and RTK's analytics/install examples.
RTK itself remains unchanged and available. Its context-budget advice and voice
protocol are no longer automatically imported; the actionable checkpoint and
voice closeout semantics are retained above. Deleted default-behavior restatements
have not been established as no-ops through model experiments.

## Local dependencies

The gold corpus is intentionally ignored and absent from a clean checkout. The
new authoring reference names its canonical Mac path as a fallback. Editorial
provenance and curated memory are private local inputs. The installed marketing
skill points to the local playbook/templates, which are also outside this PR.
Keep those inputs private when checking reference availability.

Shared policies, RTK, installed skills, and profiles are dependencies on Valentin's
Mac. Missing dependencies must be reported for the affected branch; their absence
does not block unrelated work. Existing style and application files are unchanged.

## Cross-project migration

The install manifest is the exact source/target inventory. Its baseline hashes
capture the reviewed local files, including owner-specific additions. It contains
paths and hashes, never credentials or private corpus/profile contents.

| Bundle | Installed project level | AGENTS lines before → after |
| --- | --- | --- |
| Global | `~/.codex/AGENTS.md` | 198 → 24 |
| Shared | `WORK/valentin-rules/AGENTS.shared.md` | 331 → 29 |
| Assistant | `WORK/codex-telegram-assistant` | 33 → 13 |
| TVK | `WORK/trenervkarmane` | 338 → 34 |
| GMK | `WORK/gde-moi-klienty` | 344 → 33 |
| GU | `WORK/gdeucheniki` | 106 → 20 |
| GMD | `WORK/gde-moi-dengi`, including `app/` | 5 + 200 → 6 + 20 |
| TVP | `WORK/telovporiadke` | 36 → 19 |
| Dialogs | `WORK/dialogs` | 15 → 10 |
| ValBarko | `WORK/valbarko-site` and `Documents/ChatGPT/ValBarko.ru` | 27 → 9 in each |
| WellTravel | `Documents/WellTravelClub` | 89 → 38 |
| DDX | `WORK/ddxmoremall` | 20 → 17 |
| RoadFlow | `WORK/roadflow-lab` | 10 → 6 |
| Writing bank | `WORK/valentin-writing` | 17 → 15 |

Counts describe the always-loaded files, not all reference material. DDX keeps
its useful compact boundaries; the goal is relevant instructions, not minimum
line count. Small projects reuse existing runbooks instead of gaining empty
CODING_STANDARDS files. GMD keeps both root routing and app-specific scope.

Shared standards own PHP/CI, analytics, browser/code-map and infrastructure
branches; shared workflows own lane selection, delivery, cleanup and backup.
Project standards retain data/product/UI constraints; TVK/GMK/GMD workflows
retain their distinct wrappers, access, release and isolation requirements.
Existing canonical browser, UI, SEO, proxy, typography and marketing policies
remain authoritative. TVK's linked lane document is reconciled with its root
rules on reclassification, retired staging and WORK checkout examples.
WellTravel analytics replaces its unavailable static-patch helper reference
with a snapshot/diff/hash-checked procedure. Weekly analytics discovers an
existing clean baseline instead of assuming a nonexistent fixed GMK checkout.

Two inspected TVP feature worktrees (`telovporiadke-learning-courses` and
`telovporiadke-zero-carbs`) are excluded from installation. Their task-specific
snapshots belong to their branches; this migration does not rewrite other task
checkouts. Both independent ValBarko copies are mapped explicitly. Sibling
repositories receive only the listed instruction/reference files as local
changes; their branches, commits and unrelated files are not synchronized.
All reviewed migration sources remain versioned in this one PR.

## Plan, apply, verify and restore

Run from this reviewed checkout on Valentin's Mac:

```bash
rtk proxy python3 -B scripts/agent-instructions.py plan
rtk proxy python3 -B scripts/agent-instructions.py apply
rtk proxy python3 -B scripts/agent-instructions.py check
```

`plan` checks source SHA-256 and every target's reviewed baseline without writing.
`current` is a safe no-op, `create`/`replace` is planned, and `drift` stops the
whole apply before replacement. Reconcile drift in the source bundle and manifest
before retrying. Treat the manifest as a reviewed Mac-specific inventory, not a
generic installer for another machine. Recompute a source checksum whenever its
reviewed content changes; new target baselines require a fresh review/snapshot.

`apply` snapshots managed files and original modes in a private directory under
`~/.codex/backups/agent-instructions-*`, prints its path, and stages all new files.
References precede project/shared routers; the global router activates last.
Immediately before each rename it rechecks the live target, staged content and
already-current/installed references. It then verifies every installed hash.
Atomicity is per file; the batch is not a filesystem transaction. A conflict or
interruption may leave a partial install; use its recovery journal. Concurrent
writers cannot be locked by this utility, so stop editing managed files during
apply; preflight and immediate rechecks detect observed drift.

Restore only the files owned by that installation:

```bash
rtk proxy python3 -B scripts/agent-instructions.py rollback --backup /absolute/printed/backup
```

Rollback checks installed hashes and snapshot integrity, restores routers before
removing their new references, and preserves unrelated directory entries. Later
managed-file edits stop rollback; preserve/reconcile those edits first. Keep the
backup until routing is accepted. RTK, profiles, corpus, skill sources, application
runtime, databases and production infrastructure are outside the manifest.

## Verification scope

```bash
rtk proxy python3 -B test/agent-instructions-test.py
```

Filesystem integration tests cover apply/rollback, permissions, repeat application,
baseline drift, concurrent edits (including intent-journal writes), changed
references, symlink targets, modified sources and corrupt snapshots. Cross-project
checks verify source hashes, target mappings, sibling links, canonical dependencies,
existing project runbooks, and the old-to-new guard coverage. A temporary replay
of the full manifest checks installation and restoration without touching live
paths. These are instruction/configuration checks, not server or product QA.

## Routing checks

| Task | Expected references/behavior |
| --- | --- |
| Fix a TypeScript handler | Project and global CODING_STANDARDS; product-contract sections if affected. |
| Review access-control code without editing | Both CODING_STANDARDS and the product's Safety and privacy requirements. |
| Read a web page in an existing account | Global CODING_STANDARDS → Browser use and checks → shared browser policy. |
| Replace one approved sentence | Current passage/context; no corpus or marketing rewrite. |
| Draft a personal essay | AGENT_WRITING → STYLE and local gold; provenance for article-bank examples. |
| Plan a Reel or marketing adaptation | Installed marketing skill; authorial retrieval only if writing in Valentin's voice. |
| Recommend a trip or rank owned projects | WORKFLOWS → all four profiles, LIFE advisory and durable-asset rules. |
| Edit a public Russian landing page | Interface/browser rules as applicable, SEO skill and final typography skill. |
| “сделай пр” / “закрой без деплоя” / “закрыто?” | Draft PR / full closeout excluding deployment / status only. |
| Preview from a phone | CODING_STANDARDS → Phone previews; LaunchAgent, LAN URL, three-hour TTL. |
| Enable an optional MCP or challenge a factual correction | WORKFLOWS → the matching RTK policy. |
| Deliver a spreadsheet | WORKFLOWS → Artifacts; file and verification, clickable link without automatic preview. |
| TVK Android push/badge source change without a build | Project WORKFLOWS → Store artifacts: frozen RC4 and provider/source scope. |
| TVK/GMK analytics UI design without editing code | Shared CODING_STANDARDS → Analytics: existing no-banner and private-data boundaries. |
| TVK Tiny task grows to DB or broader visual QA | Reclassify the same authorized task; read the new lane's checks. |
| GU production planning | Accepted direct-production ADRs; preserve isolated/exact-main release and reuse decisions. |
| GMD app code review without implementation | App standards and scope; read-only review does not initiate SSH or local services. |
| TVK/GMK weekly report | Canonical shared weekly analytics; read-only discovery of an existing clean baseline. |

Validate relative file links and the local-only paths separately. Review every old
section against the migration map and every trigger against these scenarios.
Static checks establish reachability and rule ownership. They do not measure
model-default no-ops or guarantee actual agent compliance. A fresh task after
installation is needed to assess runtime routing; this conversation already
contains the previous instructions.
