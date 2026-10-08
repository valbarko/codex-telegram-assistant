# ValBarko.Ru: coding standards

## Implementation and checks

Use the checkout's current `package.json` for Astro commands and affected checks.
Preserve canonical URLs and existing URL/redirect checks; migration reports are
historical evidence, not authorization to switch the site again.

## Analytics

Preserve the owner's no-banner decision: public GA4 starts directly while prior
explicit refusals and browser privacy signals remain respected. Keep private-route
exclusions and sanitized payloads. Consent UI is not restored from legacy asset
names, and a synthetic saved consent is not a way to suppress UI. Changes to this
integration require the GA4 unit and browser checks in
`scripts/test-ga4-consent.mjs` and `scripts/verify-ga4-browser.mjs`.

## Production and shared routing

The public site is `https://valbarko.ru`. Its recorded production target is
`gmk-prod-1`, SSH alias `gmk-root`, Astro root
`/srv/sites/valbarko.ru/public-astro`, redirect map
`/etc/caddy/valbarko-redirects-final.map`. Verify current state before operations.

Before shared Caddy changes, read
`/Users/valentinbarko/WORK/valentin-rules/shared-reverse-proxy.md`.
Preserve the complete configuration, sibling hosts and ValBarko redirect-map
import. In addition to all-host smoke, verify ValBarko redirects, static assets,
shared PDF/video paths and Metrika counter `104771424`; a site-only smoke is
insufficient. General authorization/closeout comes from the global workflow.
