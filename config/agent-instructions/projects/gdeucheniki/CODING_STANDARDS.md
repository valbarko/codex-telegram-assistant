# Где мои ученики standards

Paths below resolve from the installed repository root. Read matching sections.

## Independent fork and product boundary

Use `docs/decisions/0003-independent-gmk-fork.md` for bootstrap or a selective
port. Record the source repository, commit, and copied scope. The fork develops
independently; neither automatic/manual synchronization, shared packages,
compatibility wrappers, sibling imports, production symlinks, nor changes to GMK
are prerequisites. Each selective port is an ordinary local change with its own
review, checks, and release.

Copy only source, required schema, assets, and tests. Real data, credentials,
dumps, uploads, logs, session/runtime state, and host-specific operational
settings stay outside the copy. Adapt this project's domain, jobs,
configuration, and deployment targets before running copied code.

The tutor domain owns students/parents, lessons/groups, homework/learning
progress, and tutor-specific balances, cancellations, and reporting. Workouts,
measurements, fitness subscriptions, and TVK integration are outside this scope.

## Decisions and delivery

Use accepted decisions in `docs/decisions/` for the affected scope. Read
`docs/decisions/0007-direct-production-release.md` and
`docs/decisions/0009-production-crm-runtime.md` before production work. They own
local/synthetic-CI verification followed by direct production release without
staging, the isolated runtime, exact-main release, migrations, backup, smoke,
rollback, and neighboring-service protection.

The existing stack, fork, direct-release model, and isolated first runtime are
accepted. Before new infrastructure, real tutor/student/parent/payment/message
imports, or enabling billing, notifications, booking, or public profiles in
production, identify the applicable accepted ADR. Record a missing decision
before the implementation step that depends on it. Related decisions may be
documented together; the list is not a requirement for separate approval rounds.
Older bootstrap/empty-database statements do not establish current runtime state.

Apply the same decision lookup before unresolved data-model/personal-data,
authentication/account-isolation, hosting/check/deploy/backup/rollback, or
acquisition-through-activation/payment analytics choices. Reuse accepted ADRs
rather than reopening those decisions. `docs/decisions/0002-public-prelaunch.md`
owns the approved public site and aggregate CTA-measurement scope.

## Interface and naming

Follow `/Users/valentinbarko/WORK/valentin-rules/mobile-interface-skills.md` for
the changed surface. Current PHP CRM/PWA/TWA screens use web skills and this
product's brand; native companion guidance requires an actual native manifest
in the checkout being changed.

`docs/decisions/0008-application-naming.md` owns simple auth route names, `tutor`
as the domain-owner term, and `gu` internals. Runtime paths, symbols, schema, and
assets use this project's names rather than the retired fitness role or source
namespace. The immutable fork manifest may preserve original source names as
provenance. `docs/brand/identity.md` owns wordmarks and the text-free icon used by
PWA, TWA, Apple Touch, and favicon surfaces.

## Copy and privacy

Public Russian copy uses `вы`, `ваш`, `вас`, and `вам`. Promise features, prices,
integrations, results, or legal compliance only when implemented and verified.
Auth, verification, private schedules, students, parents, payments, messages,
exports, and service routes are `noindex` by default. Keep real secrets,
credentials, database dumps, and personal data out of commits.
