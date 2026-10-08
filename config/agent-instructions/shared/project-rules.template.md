# Project instruction template

Use this as an editing aid, not an automatically loaded instruction file. Keep
only the branches and boundaries the actual project needs. Installed relative
paths resolve from that project's root; absolute paths are local dependencies.

```md
# <Project> instructions

@/Users/valentinbarko/WORK/valentin-rules/AGENTS.shared.md

<Product and data boundary that must be known before choosing a workflow.>

- <Code/review or product-specific risk trigger>: read `CODING_STANDARDS.md`.
- <Release/server/data-operation trigger>: read `<existing current runbook>`.
- <Authoring/design branch, only if the project has one>: read `<its source>`.
```

Include shared defaults only when they fit the project. A server-first exception
or another established delivery model belongs in its own explicit route.

Keep available commands, compiler/runtime versions, database configuration,
ports, and dependencies in their existing configuration or runbooks. Add a
documented gotcha or boundary when looking at that source is insufficient.
Do not require `make ship`, PHP/Composer, local databases, preview servers, or
browser caches in projects that do not use them.

For a maintained CodeGraph checkout, the project workflow owns its path,
baseline/freshness procedure, refresh, and supported-language limitations. A
project without that declared checkout skips the branch.

Use existing canonical browser, interface, SEO, proxy, backup, and owner
policies through precise triggers. Add product standards for facts those
sources do not own; keep each meaning in one authoritative place.
