# Где мои деньги

GMD is separate from InYourBody. Use only GMD resources; its work does not
authorize changes to InYourBody code, services, databases, secrets, deployment,
runners, logs, backups, or reverse-proxy configuration.

Implementation, build, verification, and release preparation run in the GMD
server checkout unless Valentin explicitly requests local work. Local review,
planning, and diff analysis may remain read-only without SSH or local services.

- Code changes/review, data operations, interface work, or copy: read the
  matching sections of `CODING_STANDARDS.md` beside this file.
- Server access, GitHub credentials, branches, builds, DB, deploy, firewall,
  reverse proxy, or backups: read `WORKFLOWS.md` beside this file first.
- Product-status questions: inspect current code and the requested roadmap.
  `docs/product-scope-history.md` is historical context, not an automatic backlog.

Paths below these instructions resolve from the repository's `app/` directory.
Server-first operation does not permit deploying uncommitted source or an
unmerged branch without the owner's explicit exception.
