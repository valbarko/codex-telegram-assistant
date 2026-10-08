# ГМК / Где мои клиенты

This repository owns the standalone trainer CRM: clients, calendar, packages,
finance, availability, support, trainer settings, referrals and CRM Telegram.
Client training and Где мои деньги remain separate products. Tracked runtime code
is GMK-owned; `docs/extraction/legacy-workflows/` and historical extraction evidence
do not authorize restoring removed product surfaces or source deploy targets.

Preserve CRM auth/session (`gmk_sid`), CSRF, registration verification, Telegram
binding, support, finance, calendar and notifications. Keep GMK secrets, bots and
deployment targets separate from TVK. Never copy ignored `config/db.php`.

The canonical root/data checkout is `/Users/valentinbarko/WORK/gde-moi-klienty` and
may host parallel work. Use the existing task sandbox or project worktree wrapper
before implementation. Inspect another repository only within explicitly provided
cross-project scope; shared ancestry does not authorize changes there.

Read the matching branch before acting. Existing script and runbook paths resolve
from the GMK repository root; mobile paths resolve from the identified active
companion checkout, whose manifest must be inspected first.

| Task | Read |
| --- | --- |
| Code changes/review or code mapping | Matching sections of [CODING_STANDARDS.md](CODING_STANDARDS.md) |
| UI/copy, browser QA, mobile configuration/build/install | Corresponding sections of [CODING_STANDARDS.md](CODING_STANDARDS.md), including native launch checks before delivering a mobile artifact |
| Task/worktree start, PR/merge, CI, production/SSH/secrets or Telegram operations | Matching sections of [WORKFLOWS.md](WORKFLOWS.md) before selecting a command |

For code, review, interface/analytics planning or implementation, and local QA read matching sections of
`/Users/valentinbarko/WORK/valentin-rules/CODING_STANDARDS.md`; for release,
cleanup or backup use matching sections of
`/Users/valentinbarko/WORK/valentin-rules/WORKFLOWS.md`.
For weekly analytics read `/Users/valentinbarko/WORK/valentin-rules/codex-weekly-analytics.md`.
Project wrappers and boundaries retain precedence over shared defaults.
