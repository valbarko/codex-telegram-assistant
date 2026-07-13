# Мастерская текстов

Большие статьи и авторские материалы для Валентина создаются в этом каталоге. Правила голоса находятся в `VALENTIN_STYLE.md`, а исходный корпус хранится локально в `.private/style-corpus/` и не попадает в Git.

## Обновление корпуса

1. Положить свежие экспорты Telegram в:

   - `.private/style-source/barko-pro-zhizn/result.json`
   - `.private/style-source/v-svoem-tele/result.json`

2. Пересобрать и проиндексировать:

   ```bash
   npm run style:build
   npm run style:index
   ```

3. Найти примеры перед написанием. Запросы выполняются последовательно:

   ```bash
   npm run style:search:personal -- "личная статья о работе тренера с лёгкой самоиронией"
   npm run style:search:expert -- "пост тренера о восстановлении после нагрузки"
   ```

Черновики можно хранить в `writing/drafts/`.
