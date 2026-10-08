# GMK coding standards

Read matching sections before changing or reviewing that behavior. Existing paths
resolve from the GMK repository root; mobile files belong to the identified active
companion checkout, not a presumed local `apps/mobile` tree.

## Scope, lanes and security

Use `safe` for docs, local-only extraction cleanup and route-local changes;
`risk` for DB/schema/data, auth/session/CSRF/security, secrets/Telegram credentials,
CI/CD/runners, deploy, staging or production infrastructure. `review-only` makes
no writes. Select developer/reviewer/architect/infra/data-migration role by the work.

Preserve all CRM auth/session, verification, support, finance, calendar and
notification contracts. Auth/CRM ancestry overlaps `trenervkarmane`; record when
a shared-code security fix also applies there, but port only within authorized
cross-project scope. Do not create another task or modify TVK just because code
was shared. Historical workflows stay disabled until rewritten for GMK.

## Public copy and interface implementation

Active public runtime, CRM/admin copy, docs, screenshots, email, Telegram/PWA/legal
text, deploy scripts and examples use GMK names/domains. Historical extraction docs
may name the source system. Use formal `вы`/`ваш`/`вас`/`вам` unless Valentin
explicitly requests informal address for the exact surface.

Before interface design/implementation/polish/review read
`/Users/valentinbarko/WORK/valentin-rules/mobile-interface-skills.md`.
PHP web/PWA/Mini App screens use web skills and `docs/ui-conventions.md`.
Render Phosphor via `ph_icon()` inline SVGs from `config/icons.php`. Register new
path data and verify a nonempty result before using an icon. Ordinary product/admin
UI does not use CSS-font `ph`/`ph-*` tags; only isolated vendor/demo surfaces that
explicitly load the vendor icon CSS may use them.

For React Native/Expo companion work, identify its active checkout and inspect
`apps/mobile/package.json` before choosing native guidance. Preserve current
navigation/motion; polish does not authorize adopting Router/Reanimated.

## Native iOS startup and iPad artifacts

Read before native configuration, builds, signing/repackaging, installation or
delivery. Launch/tablet fixes belong in tracked `apps/mobile/app.json`, config
plugins and the lockfile. Ignored `ios/`, a local AppDelegate or a previously
signed binary alone is not durable across clean prebuilds/worktrees.

For SDK 57 preserve compatible locked `expo-build-properties` with
`ios.enableSceneSupport: true`; generated `UIApplicationSceneManifest` points to
`EXExpoAppSceneDelegate` and AppDelegate implements `ExpoReactNativeFactoryProvider`.
Keep `ios.supportsTablet: true` and device family `[1, 2]`. An SDK upgrade may
replace this mechanism only with a verified equivalent, not by disabling support.
The missing-scene regression was confirmed on the owner's iPadOS 27 on 2026-10-06.

Before building main/another branch/reused native sources, verify approved launch
fixes are present. Do not deliver an older native shell or merely swap JavaScript
without checking them. In the active companion run
`npx expo prebuild --platform ios --no-install`, then `npm run ios:verify`.
Before installation verify the exact final signed `.app` with
`npm run ios:verify -- /path/to/Gdemoiklienty.app`, including after repackaging or
re-signing. A failing launch guard blocks delivery of that artifact.

Check cold and second launch of the delivered version on iPadOS 27 or newer
supported OS, including the physical iPad when available/unlocked. Compilation,
signature and installation do not prove launch. If unavailable/locked, continue
build/simulator checks and report physical launch unconfirmed; simulator rendering
does not establish installed app/session/CRM/offline-data behavior.

## Browser and authenticated UI QA

Use the project `test:e2e:install` script to repair browsers compatible with
`playwright.config.js`. PWA asset smoke uses
`GMK_VISUAL_QA_BASE_URL=http://127.0.0.1:<port>` with
`scripts/crm-pwa-icon-http-smoke.mjs` against the relevant local server.
Finite PHP previews use `scripts/start-local-server.sh --background <port>` and
the shared `com.valentin.local-preview.supervisor`; never a per-port/worktree plist
executing PHP. Keep the separate warm shell-backed `com.valentin.gmk.local-php`
at `:8081` running during routine QA.

Before pre-deploy authenticated CRM/admin QA, seed/refresh the synthetic local
trainer using `php scripts/local-trainer-visual-qa-seed.php --config=config/db.php`.
Local-only login is `e2e+trainer@example.test` / `12345678`; the seed keeps it active
and verified. Render the changed build beyond the login redirect. Do not use this
fixture for destructive flows without an explicit request.

Production shows only the deployed version. For post-deploy/explicit production
diagnosis use canonical trainer `prod-crm-trainer-mqqv8w1b-3cd423@example.test`
when its session/access is available; missing production credentials do not block
independent local preparation. Claim visual QA only after rendering that version.

## Code mapping and evidence

For PHP/JavaScript mapping use maintained `tmp/worktrees/gmk-codegraph-current`
before broad search when its `HEAD` matches `origin/main`, explicitly via
`codegraph explore -p <path> ...`. Follow `docs/runbooks/codegraph-workflow.md` for
freshness/refresh/branch-local details. Ordinary task worktrees need no own index.
Use exact symbols/files; graph results are navigation, validated with `rg`.
Known files, shell/docs/config and computed PHP includes use direct reads/`rg`
first. Fall back when stale/unavailable; no implicit rebuild or resident MCP.

Read extraction context/access/DB docs only for the affected branch. Never read
secrets or production dumps as exploratory code context. Review changed behavior
with proportional checks and concrete blocking findings, preserving uncertainty
when the relevant runtime or artifact was not inspected.
