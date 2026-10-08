# GMD application standards

Read matching sections. Relative paths resolve from the installed `app/` directory.

## Product and resource isolation

Product: «Где мои деньги — семейный бюджет и расходы», technical prefix `gmd`.
Keep GMD code, data, runtime, and operations separate from InYourBody; its paths,
DB/service/container names, environment files, and naming conventions are not
templates to reuse. Server resource boundaries live in `WORKFLOWS.md`.

Keep secrets out of commits, logs, chat, screenshots, PR descriptions, and
command output. Destructive DB commands and resetting real-server Docker
volumes are outside normal work. Firewall changes require inspection of the
actual rules; shared reverse-proxy changes use the canonical policy rather
than replacing a complete configuration.

## Interfaces and language

Follow `/Users/valentinbarko/WORK/valentin-rules/mobile-interface-skills.md` for
UI work. The current React/Vite application uses web polish and relevant Apple
interaction guidance with its existing graphite/gold components. Native skills
apply only to an actual native surface. Interface work preserves server-first
operation and does not start local services.

UI language is Russian. Use the product's established terms:

- Доходы, Расходы, Переводы, Счета, Цели, Журнал.
- План, Факт, Отменено, Вычеркнуть, Наличные.
- Общее, Личное, Приватное, Доступ, Участники.
- Аналитика, Чеки, Выписки.

Use these terms rather than `транзакция` as the main UI word. Product name in
the UI is «Где мои деньги»; subtitle is «Семейный бюджет и расходы». Preserve
dark graphite, premium gold, and white/silver text.
