# WellTravel.Club

Read only the branch needed by the current task. Narrow edits preserve approved
wording and existing authorization without starting a publication pipeline.
Existing paths resolve from this project root.

| Task | Read |
| --- | --- |
| New/revised active tour offer | `docs/agent-workflows/tours.md` and `astro-tours/README.md` |
| Editorial guide, hub, SEO or content policy | `docs/agent-workflows/editorial.md` and the scoped global SEO skill |
| Brand, covers or photographs | `docs/agent-workflows/brand-media.md`; owned-photo watermark rules in `docs/agent-workflows/tours.md` |
| Article from Telegram archive | `docs/agent-workflows/telegram.md` and the established authorial guidance |
| WordPress implementation, review or publication | `docs/agent-workflows/wordpress.md` |
| Server files, deploy, access or tooling | `docs/agent-workflows/operations.md` |
| GA4/analytics UI, Metrika, Partner API or Webmaster | `docs/agent-workflows/analytics.md` |

- Active tour offers use shared Astro schema/components in `astro-tours/`;
  WordPress serves editorial archives, hubs and contacts. Preserve canonical URLs;
  migrated WP tour implementations are rollback history.
- Editorial guides keep their evergreen framing. Active Astro offers use only
  their documented intro/closing registration/question areas and protected
  contacts flow. Test mail is intercepted; real test messages need authorization.
- Preserve clean photo masters. Owned-photo publication derivatives carry
  `© Валентин Барко`; third-party photos retain their actual ownership. Use the
  current `audit/design/welltravel-brandbook.md`, not retired design comparisons.
- Keep confirmed facts, secrets, unrelated/untracked files and local canonical
  server-bound source safe. Shared-host changes follow
  `/Users/valentinbarko/WORK/valentin-rules/shared-reverse-proxy.md`.

Use each branch's affected tests and render checks. Tour schema/template/responsive
changes retain the fixture/browser matrix. HTTP alone does not prove layout;
report missing visual evidence and recover with permitted tools. Global typography,
SEO, artifact and no-preview rules apply. Substantial-release measurement dates
do not imply early causality or authorize automations.

Procedures belong in the matching workflow; dated observations belong in project
context. `docs/agent-workflows/backlog-history.md` is historical, not an automatic
request to start more work.
