# Cross-project coding standards

Read matching sections before the corresponding work; repository instructions
retain their product-specific requirements.

## Implementation and review

For a substantial code handoff, inspect the diff for merge-blocking defects;
report each concrete finding with its file, location, and reproduction. State what
changed, what was actually
verified, and what remains unconfirmed, including where you looked.

## User-facing copy

Write descriptions, onboarding, captions, notifications, and errors around what
the person can do or expect. Keep technical diagnosis in private logs and developer
reports. Include implementation details in user-facing copy only when Valentin
explicitly requests them; secrets and raw errors remain private.

For failures, say what happened and give a useful next step. Base retry advice and
recovery times on evidence. Before release, review every changed user-facing string
for unnecessary technical details.

## Interfaces

Before interface design, implementation, polish, or review, read
`/Users/valentinbarko/WORK/valentin-rules/mobile-interface-skills.md`.
It owns skill selection for the actual stack and installed dependencies.

## Browser use and checks

Before browser use, read
`/Users/valentinbarko/WORK/valentin-rules/browser-policy.md`.
It owns browser selection and the shared Playwright cache requirements.

For Playwright checks, resolve the project's own CLI. If its compatible Chromium
revision is missing, install Chromium through that CLI and retry. On Linux CI
missing system libraries, use its `install --with-deps chromium` command. A revision
from a different Playwright version is not evidence of compatibility.

## Phone previews

When Valentin needs a local/worktree server accessible from a phone, run it through
a user LaunchAgent, bound to `0.0.0.0:<port>` with a three-hour TTL. Verify the LAN
IP URL and restart the preview if more time is needed. In TVK use
`scripts/start-local-preview-server.sh <port> 10800 <label>`; elsewhere use the same
lifetime pattern. A short-lived shell background process can disappear before the
phone connects.

## Indexed-code exploration

When `.codegraph/` exists, prefer `codegraph explore` for unfamiliar symbols and
cross-file relationships. Use `rg` or direct reads for precise known lookups, or
when the index/CLI is unavailable, stale, or unhelpful. Repair or build an index
only when the task needs it; repositories without `.codegraph/` skip CodeGraph.
For work that specifically requires its MCP integration, follow Evidence and tools
in `/Users/valentinbarko/.codex/agent-instructions/WORKFLOWS.md`.

## Shared reverse proxy

Before changing shared Caddy/Nginx configuration, read
`/Users/valentinbarko/WORK/valentin-rules/shared-reverse-proxy.md`.
That policy owns host inventory, backups, complete live imports, atomic replacement,
validation, rollback, and all-host smoke checks.
