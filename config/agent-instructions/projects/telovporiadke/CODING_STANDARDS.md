# Тело в порядке: coding standards

Read the sections matching the task. Existing paths resolve from the project root.

## Product boundaries

- Use one product API and writer for app/bot. Save nutrition estimates only after
  explicit user confirmation. Public AI requests require owner-only activation;
  anonymous AI access is not enabled by this workflow.
- Owner-only messaging bridges approved on 2026-10-02 may read TVK/GMK/GMU human
  support conversations and send through each product's own writer. They expose
  only minimal recipient/chat data; foreign accounts or conversation histories
  never enter the nutrition database.
- Runtime secrets remain on the VPS outside releases and the web root. Use
  existing authorized integrations; keep secrets out of Git, logs, mobile bundles
  and tool output. Shared-host changes preserve sibling services and follow
  `/Users/valentinbarko/WORK/valentin-rules/shared-reverse-proxy.md`.
- Public copy describes the person's state, outcome and useful next action.
  Render external text through the approved public-copy boundary, keeping
  provider/model names, API/server/request/queue/cache/sync/session terminology,
  status codes, identifiers and raw diagnostics in private logs/telemetry.
- Keep required registration consents. App activity already described in published
  documents does not introduce document-update or analytics-consent screens.
  When enabled, bounded client events cover every authenticated account without a
  document-version gate and exclude text, photos, entered values and tap coordinates.

## Interfaces

Use `/Users/valentinbarko/WORK/valentin-rules/mobile-interface-skills.md` for the
actual changed surface: Expo/React Native mobile or PHP site/cabinet web UI.
Preserve custom `App.tsx` navigation, installed packages and reduced-motion-aware
transitions. A skill does not authorize adding Expo Router, React Navigation,
Reanimated or `@expo/ui`.

- Show explicit-action progress and confirmed success in the existing CTA button;
  reset its label when the form changes. Prevent duplicate submissions and keep
  uncertain outcomes distinct from success. Keep accessible labels. Separate
  explanations address a real problem, conflict or required permission; avoid
  generic success text, toasts and alerts.
- Carousels rotate automatically without play/pause controls. Pagination uses
  equal circular dots, with active fill rather than a stretched bar. The burger
  menu scrolls vertically by touch without a visible scroll indicator.
- Quantity-only fields use the native decimal keypad on both platforms. Accept
  comma and point, normalize before validation/API calls; other field types keep
  their appropriate keyboards.
- Every `Удалить…` action requests native `Нет`/`Да` confirmation explaining what
  disappears or remains before mutation.
- Saved-data fallback revalidates on reconnect and foreground. Its status persists
  through failure and disappears only after confirmed success, using the shared
  presence transition. Connectivity or matching public copy does not prove success.
- Background refresh preserves mounted content, scroll and geometry. A visited
  screen renders exact cached values immediately; placeholders occupy the same
  layout only when no saved values exist. Healthy revalidation is silent;
  saved-data status describes an unavailable/failed refresh. Keep pull-to-refresh
  independent from background loading. Background loading preserves content and
  does not replay whole-card entrances. Animate changed numbers in place with
  the shared value transition, tabular digits and reduced-motion support.

## Verification

Use the existing branch/check/PR/CI/merge path before production deployment.
Before the first push and every code, migration or workflow update to an open PR,
run `bash scripts/check.sh`; remote CI is not the first full test run. Shared
production operations follow the matching sections of
`/Users/valentinbarko/WORK/valentin-rules/CODING_STANDARDS.md` and
`/Users/valentinbarko/WORK/valentin-rules/WORKFLOWS.md`.

## Mobile releases

`docs/FULL-APP-RELEASE.md` owns «Выпусти приложение везде»: public App Store,
Google Play and RuStore, site iPhone/Android links, signed direct APK, and the
same build installed and checked on both iPhones. No separate «закрой» is needed.
Store submission is not public availability. Keep pursuing review outcomes and
report each unfinished channel's concrete blocker; a server-only task does not
imply a full mobile release.

Start device testing on Valentin's iPhone and preserve Android compatibility.
Installation on Valentin's and Alena's iPhones is already authorized.
Store reviewers and managed test users require preverified password-only service
accounts (`users.is_service_account=1`), provisioned through `provision-store-review`
or `provision-test-account`. Preserve issued passwords across releases and verify
the credentials actually supplied to each store; email codes/recovery are not the
release login path. Personal and ordinary beta accounts remain distinct.
