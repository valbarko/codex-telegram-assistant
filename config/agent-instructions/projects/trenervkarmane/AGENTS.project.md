# Тренер в кармане

TVK is the client training/coaching product on `trenervkarmane.ru`, bot
`@tvk_trainer_bot`. GMK is the separate CRM/calendar/finance product, bot
`@gdemoiklienti_bot`. Platform `users` and CRM `crm_users` /
`trainer_crm_clients` are distinct identities unless an explicit code path links them.

The production browser/PWA runtime has real users, sessions, workouts and offline
data. Preserve them; store-app rollout is not a clean-slate migration. Retiring the
standalone/installable PWA channel needs a separate audited project and explicit
command; the shared PHP/web runtime remains required by the thin store wrappers.

Work within `/Users/valentinbarko/WORK/trenervkarmane` and the authorized task
checkout. Search outside it only when Valentin supplies the path or scope.
Preserve user changes. Superseded native-client branches/worktrees/archives are
historical evidence; current `origin/main` and the thin-wrapper plan are canonical.

Read the matching sections before the operation. Existing runbook and script paths
below resolve from this repository's root, including when using a task worktree.

| Task | Read |
| --- | --- |
| Implementation, review, or code mapping | [CODING_STANDARDS.md](CODING_STANDARDS.md); classify the lane before edits |
| Client UI, copy, native wrapper, analytics, or AI replacement | The corresponding sections of [CODING_STANDARDS.md](CODING_STANDARDS.md) |
| Start/continue a task, local runtime/DB, GitHub, PR, or cleanup | [WORKFLOWS.md](WORKFLOWS.md) |
| Production/data write, AI credentials, release/status, or store artifact | The corresponding sections of [WORKFLOWS.md](WORKFLOWS.md) before selecting a command |
| Native source, push, permissions, or launcher badges | [WORKFLOWS.md](WORKFLOWS.md) — Store artifacts and runtime parity |

For code, review, interface/analytics planning or implementation, and local QA read matching sections of
`/Users/valentinbarko/WORK/valentin-rules/CODING_STANDARDS.md`; for release,
cleanup or backup use matching sections of
`/Users/valentinbarko/WORK/valentin-rules/WORKFLOWS.md`.
For weekly analytics read `/Users/valentinbarko/WORK/valentin-rules/codex-weekly-analytics.md`.
Project wrappers and the boundaries below retain precedence over shared defaults.
