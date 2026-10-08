# TVK coding standards

Read matching sections before changing or reviewing that behavior. Existing paths
resolve from the TVK repository root; scripts run in the selected task checkout.

## Scope and lanes

Classify before broad reading or edits; use `docs/codex/codex-workflow-routing.md`
for the corresponding lane procedure.

| Lane | Scope |
| --- | --- |
| `tiny` | Copy/grammar/labels/chips/CSS and small route-local UI polish |
| `safe` | Small changes without DB/auth/security or core-data risk |
| `full` | Ordinary feature/refactor work |
| `risk` | DB migrations, auth/security/privacy, health-data handling, training sessions/sets/history, nutrition core, CI/CD/runners or production release |
| `review-only` | Analysis without writes |

Classify health/private-data risk by the operation. Unchanged data contracts with
shell/layout/navigation/loading/lifecycle work may stay safe/full; collection,
validation, schema, persistence/cache/queue, transmission, authorization, logging,
export/consent, or health-value calculation/interpretation are risk work.

Tiny defaults: touch 1–3 files, read narrowly, run `scripts/codex-tiny-check.sh`;
skip broad docs, DB inspection, subagents and full suites unless explicitly requested.
If those become necessary, reclassify before using them.
Reclassify a broader version of the same authorized change and run its checks;
lane changes alone do not require another approval. Leave unrelated infrastructure
and production drift outside the task. Remote staging is retired; only an explicit
infrastructure rebuild decision reopens it.

## Client runtime and interfaces

Before UI design, implementation, polish or review, read
`/Users/valentinbarko/WORK/valentin-rules/mobile-interface-skills.md`.
Product screens are shared PHP/JS/CSS web UI in thin Capacitor wrappers. Apply
native skills to the affected wrapper/bridge, not Expo recipes to web screens.
Preserve shared parity and theme; an OS-specific fork needs a concrete native/OS
reason and an explicit parity record.

The client targets store apps, not desktop or keyboard-driven browser use.
Do not add/preserve browser-keyboard-specific route focus, focus rings, screen
announcers, shortcuts or desktop navigation in that runtime. Native mobile
semantics remain; existing PWA auth/workout/offline data still need protection.
Browser accessibility is not a client product or acceptance target.

## Public copy and visual conventions

Use TVK naming in public copy, docs, screenshots, email, Telegram/PWA/legal copy
and admin explanations. Historical internal technical identifiers may retain
`InYourBody` names until a dedicated migration. Address the person as `вы` unless
Valentin explicitly requests informal address for that surface. When a product
speaker is needed, use the author's singular `я`/`мне`/`напишите мне`; neutral copy
stays neutral. Do not imply a team with `мы`/`нам`/`нас`/`наша команда`.

Use existing primitives and CSS variables from `assets/css/theme.css`. Yellow CTA
backgrounds (`--t-cta-bg`/`--t-accent`) require `color: var(--t-cta-fg)` with enough
selector specificity to win against generic link/button rules; verify computed
dark text. Green requires an explicit request. Use `vbConfirm` for destructive or
important actions. Keep Russian copy natural and consistent.

## Data and AI contracts

Preserve workout logging/progression, auth/security, health/sensitive data,
notifications, admin tools and production infrastructure. Use
`docs/codex/db-reference.md` before `config/schema.sql` for DB understanding.
DB-backed UI checks follow the Risk procedure in the workflow routing document.

For AI replacing an existing deterministic block, require canonical entitlement
and all applicable access/privacy checks. Render the deterministic variant when
not entitled or when consent, generation, validation or cache fails. AI may change
language/prioritization, not canonical calculations or safety decisions. Send
minimized structured facts/reason codes, not the old recommendation copy as prompt
steering. Check both entitled and non-AI/failure paths.

## Public analytics

Before route/provider/settings changes, read `docs/runbooks/public-analytics.md`
and run `php scripts/smoke-public-metrica.php`. Counter `110779757` belongs only
on explicitly allowlisted public routes through `includes/public-metrica.php` and
`config/public_analytics.php`; never shared shell/head, authenticated, legal,
billing, admin, CRM or private routes. Keep field recording disabled; do not send
raw form values, account IDs or health/training data. Allowlisted inputs and
textareas use `ym-disable-keys`. Content analytics stays disabled until qualifying
editorial Schema.org markup passes the Publishers check.

## Rendered verification and screen assets

Render the current relevant screen before UI review, design critique or visual QA,
including Lazyweb work. Prefer local fixtures; production-authenticated checks
use `docs/runbooks/smoke-users.md`. Preserve canonical CRM QA users unless Valentin
replaces the fixture. If rendering/access is unavailable, continue independent
preparation and mark visual QA incomplete; markup alone is not visual evidence.

When `tvk_screen_meta()` adds/removes/renames CSS or JavaScript, update every
applicable runtime-route manifest, including legacy/session-integrity variants,
and the `tests/js/runtime-screen-asset-contract.test.mjs` family. Verify a warm
transition from another root tab: direct load misses partial-screen fallbacks
that recreate the docks.

Use project browser wrappers such as `scripts/playwright-smoke.sh`. New Playwright
entrypoints use `runWithPageErrorInvariant()` or a concrete
`// playwright-pageerror: allow <reason>` when the error is the test subject.
Keep the legacy baseline shrink-only; browser exceptions are primary failure
evidence. Synthetic platform accounts default to dark; other themes are explicit
test cases. Browser-local screenshot theme previews do not persist unless testing
persistence; seeds never default to light.

## Code mapping and private output

For PHP/JavaScript mapping, use `scripts/codegraph-current.sh` against the maintained
`tmp/worktrees/iyb-codegraph-current` baseline before broad searches. Follow the
CodeGraph section in `docs/codex/codex-workflow-routing.md`; validate graph results
with direct `rg`, inspect task diffs separately, and fall back without repairing
the index unless required. Known files and shell/docs/config/computed PHP includes
use direct reads or `rg` first. Do not initialize an index in every worktree.

Read `docs/codex/context-pack.md` only when targets cannot be found or broad context
is required. Read only the newest 1–2 changelog entries. Context Mode/Graphify are
optional for bulky non-sensitive output; never route secrets, credentials, raw
production dumps/uploads or health/body metrics through them. Prefer
`php scripts/ai/iyb-ai.php ...` when it fits local facts. Add dependencies only when
the task explicitly needs them.
