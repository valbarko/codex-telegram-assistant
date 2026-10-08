# GMK task and operations workflows

Read matching sections before acting. Paths resolve from the GMK repository root;
execute scripts in the task checkout. Use `rtk proxy` for exact wrapper output.

## Task worktrees and accounting

The primary root/data checkout may contain parallel work. Reuse an existing
isolated Codex sandbox or worktree holding the continued branch; create a clean
project worktree only when isolation is needed:
`scripts/new-task-worktree.sh <slug> --role developer --lane safe
--delivery-path local-only`, then use ignored `tmp/worktrees/<slug>`.
Never create ad-hoc sibling `/Users/valentinbarko/WORK/gmk-*` checkouts.

The wrapper records usage-ledger start. On ledger failure preserve the new branch,
worktree and pending-start record for backfill, report accounting failure and
continue implementation. Close the same recorded task with
`scripts/codex-finish-task.sh --minutes <N> --summary "..."`; ledger unavailability
does not mean product work failed or authorize deletion.

Run `scripts/preflight-task.sh --before-pr` before PR. Merge from a task worktree
using `scripts/merge-pr-remote.sh <pr>` so local main stays untouched. Manual
production dispatch/release smoke uses
`scripts/deploy-production-and-smoke.sh <expected-sha>`. Cleanup follows the
matching shared WORKFLOWS preservation/closeout evidence.

## Production access and runtime secrets

Before SSH/deploy/runtime-secret work read
`docs/extraction/gmk-production-access-map.md` and run
`scripts/gmk-prod-access-map.sh`. Production is `/srv/gmk` on `91.218.113.41`.
Use SSH aliases, not raw user@IP: `gmk` is the limited deploy user for uploads/switch
preflight; `gmk-root` manages runtime configuration/services/firewall/secrets.

GitHub deployment also uses deploy through `GMK_DEPLOY_*` secrets. Deploy must
not read `/srv/gmk/shared/config/db.php`; shared runtime config is `root:gmk-app`,
managed through root and excluded from release artifacts. For features requiring
a runtime secret, provision/verify it before final production smoke. Deployment
is not secret provisioning. Never copy ignored local `config/db.php`.

## Telegram bot and bridge

GMK CRM/Mini App uses `@gdemoiklienti_bot`, short name `gmk`, direct link
`https://t.me/gdemoiklienti_bot/gmk`. Use its CRM/GMK token, never TVK's bot/token.
Production Mini App auth expects `TG_CRM_BOT_TOKEN`; the compatible
`TG_CRM_BOT_TOKEN <- TG_BOT_TOKEN` alias in
`/srv/gmk/shared/config/telegram_credentials.php` belongs to this GMK bot.
Replacing it with the TVK token causes `invalid_hash` failures.

Relay/webhook services live on VPS3/VPN, alias `vps3` (same target as `vps-vpn`,
`89.125.104.128`): `gmk-telegram-crm-relay.service` and
`gmk-telegram-webhook-relay.service`. Env files are
`/etc/gmk/telegram-crm-relay.env` and `/etc/gmk/telegram-webhook-relay.env`.
Both define this bot's `TG_BOT_TOKEN`; inspect status/existence without printing it.

## CI, deployment and historical targets

Deploy/runner/workflow changes are risk infrastructure work. Use GMK environments
`gmk-production` (optionally `gmk-staging`), secrets such as `GMK_DEPLOY_SSH_KEY`,
and GMK deploy labels `gmk-deploy`/`gmk-prod` where a self-hosted deploy runner is
explicitly selected. Current `deploy-production.yml` runs GitHub-hosted;
`gmk-deploy` is reserved, not the current execution target.

Shared CI is low-privilege `val-ci`: no production secrets/DB configs/broad SSH
keys. Do not copy generic source deploy keys/hosts, `[self-hosted, prod]`,
`[self-hosted, staging]`, obsolete `[self-hosted, ci]` or source service paths.
Production deploys are serialized without mid-flight cancellation and skip stale
SHAs unless current `origin/main`; follow shared release queue/check requirements.
Use `make ship` / `make ship-risk` only through the appropriate project lane.

Before shared Caddy changes read
`/Users/valentinbarko/WORK/valentin-rules/shared-reverse-proxy.md`; preserve every
sibling block/import and run all-host smoke plus GMK route checks.

Initial extraction history is `docs/extraction/stage-1-rules-history.md`;
`docs/extraction/stage-1-notes.md` and
`docs/extraction/legacy-workflows/README.md` are context when extraction is relevant.
Archived source workflows remain disabled until rewritten for GMK. The historical
record does not authorize foreign source production targets or removed surfaces.
