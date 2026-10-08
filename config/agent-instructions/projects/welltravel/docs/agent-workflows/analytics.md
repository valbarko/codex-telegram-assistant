# WellTravel: analytics

Read only for the current operation. Paths in code spans/commands are relative
to the repository root unless stated otherwise. Dated runtime observations are
context: verify current capabilities when needed, not permanent blockers.

## Analytics UI and static changes

Preserve the owner's no-banner decision on WordPress, static services and Astro
tours: public GA4 starts directly, with prior explicit refusals and browser privacy
signals respected. Keep private-route exclusions, sanitized payloads and legacy
Cookie-Alert stripping in `wtc-site-core.php`; contact/newsletter consent is
independent. Legacy GA4 asset names do not restore UI or authorize synthetic consent.

The old `scripts/prepare-ga4-static-patch.py` reference is unavailable in this
checkout. Do not assume that helper ran or replace it with a blind rewrite.
For authorized static changes, capture the current source and SHA-256, prepare a
separate candidate, review the focused diff and affected checks, and compare the
live hash again before atomic replacement with a rollback copy. Reconcile drift
before applying. Bump affected live HTML script versions, including card-offers
and Astro tours, and clear WordPress caches through the existing operations flow.

## Metrika and Partner API

Yandex Metrika counter:

```text
55424353
```

Local secret files:

```text
.secrets/yandex_metrika_token
.secrets/yandex_partner_oauth.token
.secrets/yandex_blocks.env
```

Never print token contents.

Confirmed Metrika API access (verified 2026-08-03):

- `.secrets/yandex_metrika_token` is the existing protected read-only OAuth token (`metrika:read`, local mode `0600`);
- the token can read Management API counter configuration and Statistics API reports for `WellTravel.Club` counter `55424353` and `ValBarko.Ru` counter `104771424`;
- use this existing API access before asking the user to create or provide another token;
- never print, paste into chat, commit, or copy the token to another project; load it directly from the protected file and return only derived results;

## Shared Yandex Webmaster API

Protected OAuth token:

```text
.secrets/yandex_webmaster_token
```

Confirmed shared API access (verified 2026-08-03):

- the file mode is `0600`; never print, paste, commit, or copy the token;
- OAuth application `WTC` has `metrika:read`, `webmaster:hostinfo`, and
  `webmaster:verify` permissions;
- Yandex Webmaster API user lookup, host listing, adding an already registered
  host, and popular search-query reports were verified through the API;
- use the HTTPS apex host for reports; legacy HTTP mirrors may also be present;
- all four report targets are already added and ownership-verified:
  - TVK — `https://trenervkarmane.ru/`, Metrika counter `110779757`;
  - GMK — `https://gdeklienty.ru/`, Metrika counter `111275359`;
  - ValBarko — `https://valbarko.ru/`, Metrika counter `104771424`;
  - WellTravel — `https://welltravel.club/`, Metrika counter `55424353`.
- for weekly reports, use Webmaster for shows, clicks, CTR, average search
  position, and query/page visibility; use Metrika for visits, users, sources,
  and search-phrase visits.
- if access appears unavailable, first verify the file exists and probe the two counter IDs without exposing the credential.

Scripts:

```bash
scripts/collect_metrika.sh
scripts/metrika_revenue_inputs.sh
scripts/configure_metrika_robot_filter.py
scripts/yandex_partner_stats_probe.sh
scripts/yandex_partner_report_probe.sh
```

Current analytics safeguards (verified 2026-07-17):

- counter `55424353` uses `filter_robots=2`, so both rule-based and behavioral robot filtering are enabled;
- reporting scripts exclude recognized robots and HeadlessChrome sessions by default; the exact methodology is documented in `audit/metrika/reporting-methodology.md`;
- production Playwright scripts must call `blockMetrika()` from `scripts/playwright_block_metrika.mjs` before navigation so QA traffic is not recorded;
- the current OAuth token can read counter configuration and reports but cannot update counter settings through the Management API; authenticated Metrika UI is the working management path.

Known traffic notes:

- last noted yearly sources: direct `49464`, social `3668`, search `3551`, links `3148`;
- devices: smartphones `32564`, PC `29091`, tablets `528`;
- main search growth target is `30k-50k` search visits/year.
