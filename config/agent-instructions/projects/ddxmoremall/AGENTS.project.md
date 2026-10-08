# DDX Moremall

This calendar adapter and club Telegram bot preserve the vendored GMK design,
schedule contracts and existing 23 public subscription identifiers. GMK and TVK
remain separate products; their tokens, sessions, webhooks and account tables are
not reusable resources here. Secrets/profile data stay outside `public/` and Git.

- Implementation, schedule or binding changes: read `README.md`, including the
  signed Telegram/one-time invitation contract, source times and affected checks.
- Release, server access, data migrations or routing: read `docs/deployment.md`.
  Schedule/registry/ICS remain on the current TVK data release until the existing
  refresh flow is updated and verified as part of an authorized cutover.
- Review auth, navigation and schedule regressions before handoff.

Existing paths resolve from this project root. Shared-host changes follow
`/Users/valentinbarko/WORK/valentin-rules/shared-reverse-proxy.md`;
project snippets preserve the complete configuration. Global owner rules apply.
