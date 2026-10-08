# Agent instruction structure

This change covers the repository and Valentin's global Codex instructions in one
PR. The global files below are reviewed installation sources; opening or merging
this PR does not activate them in `~/.codex`.

## Three increasingly radical passes

| Pass | Proposal | Outcome |
| --- | --- | --- |
| 1 — conservative | Move long sections intact behind links; retain most wording. | Preserves rules, but also preserves duplicated source material and too many reference files. |
| 2 — structural | Separate code, authoring, and non-code workflows; give every reference an explicit trigger. | Adopted as the file boundaries. |
| 3 — radical | Replace copies of canonical policies with pointers; remove eager RTK import and environment caches. | Adopted where a verified source already owns the rule. Owner-specific guardrails remain explicit. |

The three subagents audited independently. The final structure combines the second
pass's task boundaries with the third pass's pruning; it is one implementation.

## File ownership

| Source | Scope and load condition |
| --- | --- |
| [../AGENTS.md](../AGENTS.md) | Automatically loaded repository router. |
| [../CODING_STANDARDS.md](../CODING_STANDARDS.md) | Project code changes/review; points to existing product contracts and configured commands. |
| [../writing/AGENT_WRITING.md](../writing/AGENT_WRITING.md) | New authorial work/substantial rewrites; retrieval and private-input handling. |
| [../config/agent-instructions/AGENTS.global.md](../config/agent-instructions/AGENTS.global.md) | Source for `~/.codex/AGENTS.md`; global router and universal owner overrides. |
| [../config/agent-instructions/CODING_STANDARDS.md](../config/agent-instructions/CODING_STANDARDS.md) | Source for `~/.codex/agent-instructions/CODING_STANDARDS.md`; code, copy, UI, browser, LAN, CodeGraph, and shared-host branches. |
| [../config/agent-instructions/WORKFLOWS.md](../config/agent-instructions/WORKFLOWS.md) | Source for `~/.codex/agent-instructions/WORKFLOWS.md`; completion, release, artifacts, memory, evidence, and tools. |

`AGENTS.global.md` is deliberately not named `AGENTS.md` in the checkout: the
installation source must not become an extra directory-scoped instruction file.
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

## Apply the global source after review

Apply from the reviewed checkout on Valentin's Mac:

1. Read the current global AGENTS and any existing reference directory. Diff each
   managed file against its reviewed source and reconcile later edits. In a fresh
   backup directory under `~/.codex`, snapshot every existing managed file and
   record its SHA-256 hash; record absence for targets that do not yet exist.
2. Stage all three reviewed files as temporary siblings of their intended targets.
   Check staged content and local dependencies before changing live files. Preserve
   all other files in an existing `~/.codex/agent-instructions/` directory.
3. Immediately before replacing each reference file, compare that live target with
   its snapshot hash or recorded absence. Reconcile drift before continuing; then
   atomically rename the staged reference into place. Record its installed hash.
4. Compare the live global AGENTS with its snapshot again, and both reference files
   with their just-installed hashes. If any differs, reconcile before continuing.
   Activate the staged AGENTS by atomic rename only after both targets are ready.
5. Record the installed files' hashes and backup path. Start a fresh Codex task to
   exercise the routing below; this conversation already contains the old rules.

For rollback, first compare live files with the recorded installation hashes.
Preserve/reconcile later edits rather than overwriting them. Restore the previous
global AGENTS atomically, then restore only the previously existing managed
reference files from their snapshots. Remove newly created managed files only
when their hashes still match this installation. Preserve all other directory
entries and later edits. Keep the snapshot until the new routing is accepted.

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

Validate relative file links and the local-only paths separately. Review every old
section against the migration map and every trigger against these scenarios.
Static checks establish reachability and rule ownership; actual agent compliance
requires exercising the reviewed global bundle in a fresh task after installation.
