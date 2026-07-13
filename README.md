# Codex Telegram Assistant

A private-by-default Telegram client for a local Codex installation, plus a small personal-assistant layer. It runs on your Mac, communicates with `codex app-server` over stdio, and does not open an inbound network port.

This repository is an independent implementation with its own source structure, protocol transport, database schema, Telegram interface, tests, and deployment scripts.

## Features

- **Codex from Telegram:** create, resume, steer, interrupt, and hand off threads with separate contexts for chats and forum topics.
- **Live agent interaction:** stream answers and handle command, file, user-input, and permission approvals without returning to the Mac.
- **Voice-first writing:** transcribe locally with MLX Whisper, then optionally let Codex clean, structure, format, and proofread diary entries or story cycles.
- **Apple Notes publishing:** append diary entries to one monthly note grouped by date, keep story continuity, and retain readable Markdown plus untouched transcript backups.
- **Spoken and text commands:** route one-shot labels such as `Дневник`, `Рассказ`, `Календарь`, `Задача`, and `Напоминание` to the correct workflow.
- **Safe calendar automation:** parse common dates locally, fall back to validated Codex extraction for ambiguous phrasing, and require confirmation before creating Apple Calendar events.
- **Personal productivity:** manage tasks, inbox captures, a FIFO Codex queue, reminders, scheduled runs, project aliases, and recently active threads.
- **Long-term memory:** store and recall project or global context with explicit pause, export, and deletion controls.
- **Daily reporting:** generate cross-project evening summaries with completed work, blockers, first and last interaction times, estimated active time, and long breaks.
- **Telegram-native formatting:** safely render Codex Markdown as headings, emphasis, code, quotes, links, and lists with plain-text fallback.
- **Mail integrations:** read Gmail through the connected Codex app and use Apple Mail only for visible drafts.
- **Always-on local runtime:** run through a macOS LaunchAgent without exposing an inbound network port or depending on the Codex desktop app lifecycle.

## Requirements

- macOS
- Node.js 22+
- An installed and authenticated `codex` CLI with `codex app-server`
- A Telegram bot token from BotFather
- MemSearch with local ONNX embeddings (`uv tool install "memsearch[onnx]"`)
- Optional voice support: Python with `mlx-whisper`

## Local setup

```bash
npm install
cp .env.example .env
# Fill TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_IDS.
npm test
npm run build
npm start
```

The `.env` file, SQLite state, logs, model caches, and local paths are ignored by Git.

## Telegram flow

- `/home` — dashboard
- `/task` and `/tasks` — capture and review work
- `/chat` — a new general conversation
- `/new` — a new project conversation
- `/sessions` — recent Codex threads, sorted by activity
- `/abort` — interrupt the current turn
- `/remind` and `/schedule` — notification or Codex run at a later time
- `/digest on` — morning task plan at 09:00 and a cross-project work summary at 21:00
- `/calendar`, `/event`, `/draft`, `/mac` — local Mac integrations
- `/recall`, `/forget`, `/about_me` — recall, delete, and inspect personal memory
- `/memory_status`, `/memory_pause`, `/memory_export` — control and export long-term memory
- `/voice` — list spoken command labels; `/story` selects the current story cycle

The persistent Telegram keyboard keeps common actions one tap away. A text sent while Codex is working steers the active turn; after it finishes, the next text starts a new turn in the same thread.

## Long-term memory

The assistant stores sanitized user messages, voice transcripts, actions, and final Codex answers. SQLite tracks exact records, namespaces, pause state, and deletions; Markdown under the private data directory is the readable archive; MemSearch/Milvus provides hybrid semantic recall. Global memory and the active project's memory are searched separately and then merged.

Passwords, API tokens, bearer credentials, JWTs, Telegram bot tokens, and OTP-like values are rejected or redacted before either SQLite or Markdown is written. MemSearch is a derived local index and can be rebuilt from the archive. If MemSearch is unavailable, `/recall` falls back to a scoped local text search.

## Voice messages

Install the local transcription dependency in a dedicated Python environment and set `WHISPER_PYTHON` to its interpreter. The default model is `mlx-community/whisper-large-v3-turbo`.

An unlabelled voice message is a plain transcription. The bot returns sender/date metadata, concise bullets, and a structured transcript with semantic bold emphasis. Audio is processed in a temporary directory and removed afterward.

Destinations are one-shot labels for both voice and text, not persistent modes. Start the message with `дневник`, `рассказ`, `календарь`, `задача`, `напоминание`, `идея`, or `запомни`, then continue normally. `дневник` sends the remaining text through Codex and appends it to one Apple Notes note per month, grouped by date and time. Use `/story <cycle name>` once to select a cycle; subsequent messages beginning with `рассказ` use the same editorial flow and the end of the previous draft as continuity context. Calendar, task, reminder, inbox, and memory labels route the remaining content to the corresponding local workflow.

Send `Дневник` or `Заметки` without additional text to receive all entries for the current day. Add text after either label to create a new entry. Telegram renders the structured entry and also sends the same content as a downloadable Markdown file.

Calendar and reminder language uses a safe parsing cascade: deterministic local rules first, then a read-only Codex structured-extraction turn when the local parser cannot understand the date or time. Codex may only return validated JSON; the application still asks for confirmation before writing a calendar event. Ambiguous or invalid results produce a clarification request instead of an action.

Every edited entry is also stored as readable Markdown under `WRITING_ARCHIVE_DIR` (default: `~/Documents/Codex Writer`). Untouched transcripts are kept separately under `Исходные расшифровки`. If Apple Notes automation fails, the Markdown copy still succeeds and Telegram reports the Notes error. The first Notes write may require permission in **System Settings → Privacy & Security → Automation**.

## System alarms on macOS

Natural requests such as `поставь будильник на 14:00` create both a Clock alarm on the Mac and a fallback Telegram reminder. The Clock integration uses a local Shortcut so it does not need Accessibility or Computer Use permissions.

Create a shortcut named `Codex Alarm` once:

1. Add the Clock action **Add Alarm**.
2. In its **Time** field, choose **Insert Variable → Shortcut Input**.
3. Keep the default alarm label or choose your own.

The bot runs it through `/usr/bin/shortcuts` and passes an explicit local date and time. Set `ALARM_SHORTCUT_NAME` if you use another shortcut name. If the shortcut fails, the Telegram reminder is still created and the response reports the two outcomes separately.

Deleting a reminder in Telegram does not delete the corresponding Clock alarm; manage system alarms in the Clock app.

## Run continuously

After a successful foreground smoke test:

```bash
chmod +x scripts/*.sh
scripts/install-launch-agent.sh
```

The LaunchAgent starts at login and restarts after crashes. Stop and remove it with `scripts/uninstall-launch-agent.sh`.

Do not run two bots with the same Telegram token simultaneously. Stop the old service immediately before enabling this LaunchAgent.

## Import user data

The one-time migrator reads only runtime user data. It does not copy source files, tests, package metadata, Git history, or license text.

```bash
npm run migrate -- /path/to/old-data-directory /path/to/new/assistant.sqlite
```

It imports tasks, inbox records, explicit memories, enabled reminders, and saved conversation pointers into the new schema.

## Safety model

- Telegram access is restricted to configured numeric user IDs.
- Background jobs decline approval requests instead of auto-approving them.
- Email mutations require separate confirmation; Apple Mail integration creates drafts only.
- The default profile uses workspace writes with no interactive approvals. Use the included read-only or review profile when appropriate.
- Secrets are never printed by the application.

See [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) for the behavioral contract.

## License

MIT © 2026 Valentin Barko.
