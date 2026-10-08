# GMD server workflow

Relative paths below resolve from the installed repository's `app/` directory.
This project-specific server-first workflow supersedes generic shared examples
of editing a server directly without committed-main deployment.

## Operating scope

Implement, build, verify, and prepare releases in `/srv/gde-moi-dengi/app`, with
the server's Docker Compose and PostgreSQL, unless Valentin explicitly requests
local work. Read-only local instruction review, planning, and diff analysis do
not initiate SSH or create local PostgreSQL, Docker, or a development server.
Do not implement locally and copy changes to production. Verify current server
state before an operation that depends on it.

Choose `architect` for design, `developer` for features, `reviewer` for diff/PR
review, `infra` for host/runtime/deploy operations, or `data-migration` for schema
and data changes.

## Server and resource boundaries

Current recorded server is `gmk-prod-1` (`91.218.113.41`): `gmk` connects as
`deploy`, and `gmk-root` as root. Scope operations to GMD:

- Project root: `/srv/gde-moi-dengi`; active checkout: `/srv/gde-moi-dengi/app`.
- Compose file: `/srv/gde-moi-dengi/app/docker-compose.staging.yml`.
- Secrets: `/srv/gde-moi-dengi/shared/env/.env.staging`.
- Backups/uploads: `/srv/gde-moi-dengi/shared/backups` and
  `/srv/gde-moi-dengi/shared/uploads`; logs: `/srv/gde-moi-dengi/logs`.
- Containers: `gmd-web`, `gmd-api`, `gmd-postgres`, `gmd-migrate`.
- PostgreSQL database and user: `gmd`.
- Public site: `https://gde-moi-dengi.ru`.

The filenames containing `staging` are existing GMD resource names; their names
do not establish a separate staging environment. Keep InYourBody resources
outside the operation. Do not reset real-server volumes, run destructive DB
commands, change firewall rules blindly, or overwrite reverse-proxy configs.

For authorized shared reverse-proxy changes, use
`/Users/valentinbarko/WORK/valentin-rules/shared-reverse-proxy.md`; preserve
complete live imports and verify every hosted domain plus GMD-specific routes.

## Repository access

Production checkout uses `git@github.com:valbarko/gde-moi-dengi.git` and its
repository-scoped deploy key at
`/home/deploy/.ssh/gde-moi-dengi_github_ed25519` (title: `gmd-prod-1 deploy write`).
The repository-local SSH command uses that identity, `IdentitiesOnly=yes`, and
`StrictHostKeyChecking=yes`.

Use the existing key for fetch/pull/push from `/srv/gde-moi-dengi/app`. Keep origin
on SSH; personal GitHub tokens/account credentials stay off the VPS. The key
stays on-server and scoped to this repository. Before reporting missing GitHub
authorization, inspect origin and `core.sshCommand`, then check `git ls-remote
origin` and `git push --dry-run` without exposing key contents. Regenerate or
replace the key only when missing, compromised, or explicitly requested.

## Branches and release

New independent implementation starts from fresh `origin/main` on a new
`codex/<task-slug>` branch. Continue an existing task on its own branch; unrelated
or closed branches are not reused. Commit and push feature work before deploying.
Deploy merged `main` unless the owner explicitly approves another source;
untracked or uncommitted source is not a release input.

## Historical environment notes

For explicit reconstruction of earlier deployment decisions only,
`docs/ops-guardrails.md` and `docs/deployment-vps2.md` /
`docs/deployment-vps3.md` retain the former vps2 topology and early setup recipes.
They are not authority to choose the current host or start local infrastructure.
Current isolation boundaries and the server/branch scope above remain controlling.
