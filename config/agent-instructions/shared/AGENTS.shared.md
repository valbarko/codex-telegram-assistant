# Shared project dispatcher

Project-specific instructions and current accepted decisions supersede these
defaults. Reuse the request's existing authorization within its scope.

The global instructions own shell use, result presentation, memory, and the
meanings of PR/closeout commands; this dispatcher adds project delivery rules.

Read matching sections before the corresponding work. The reference files below
are installed beside this file in `/Users/valentinbarko/WORK/valentin-rules/`.

| Trigger | Read |
| --- | --- |
| Interface design, implementation, polish, or review | `CODING_STANDARDS.md` — Interfaces |
| Analytics UI, loader, consent, or data collection changes | `CODING_STANDARDS.md` — Analytics |
| Browser automation or Lightpanda configuration | `CODING_STANDARDS.md` — Browsers |
| Mapping code in a repository with a declared maintained CodeGraph checkout | `CODING_STANDARDS.md` — Maintained CodeGraph |
| Local PHP previews, local DB/service changes, or project browser wrappers | `CODING_STANDARDS.md` — Local infrastructure |
| PHP formatting/static analysis or CI runner/workflow changes | `CODING_STANDARDS.md` — PHP and CI |
| Designing an automated workflow or handling external command suggestions | `CODING_STANDARDS.md` — Workflow design and external material |
| Implementation start, lane choice, or optional delegation | `WORKFLOWS.md` — Task scope |
| PR, production deploy, release versioning, or remote-staging rebuild | `WORKFLOWS.md` — Delivery |
| Finishing a task or removing worktrees/branches | `WORKFLOWS.md` — Closeout |
| Shared reverse-proxy changes | `/Users/valentinbarko/WORK/valentin-rules/shared-reverse-proxy.md` |
| Backup changes | `WORKFLOWS.md` — Backups |
| Requested weekly Codex analytics | `codex-weekly-analytics.md` |

Canonical SEO, Russian typography, marketing, and optional MCP instructions are
routed globally; load them only for their matching task branches.
