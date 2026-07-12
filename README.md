# Codex Telegram Assistant

A private-by-default Telegram client for a local Codex installation, plus a small personal-assistant layer. It runs on your Mac, communicates with `codex app-server` over stdio, and does not open an inbound network port.

This repository is an independent implementation with its own source structure, protocol transport, database schema, Telegram interface, tests, and deployment scripts.

## Highlights

- Create, resume, steer, interrupt, and hand off Codex threads from Telegram.
- Separate contexts for Telegram chats and forum topics.
- Streaming answers and interactive command, file, and permission approvals.
- Project aliases and recently active thread selection.
- Tasks, inbox, FIFO Codex queue, reminders, scheduled runs, memory, search, and daily digests.
- Voice transcription with local MLX Whisper. Voice messages never start a Codex thread.
- Gmail reading through the connected Codex app; Apple Mail only for visible drafts.
- Local Apple Calendar listing and event creation.
- Persistent macOS LaunchAgent, independent of the Codex desktop app lifecycle.

## Requirements

- macOS
- Node.js 22+
- An installed and authenticated `codex` CLI with `codex app-server`
- A Telegram bot token from BotFather
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
- `/digest on` — daily task summaries at 09:00 and 20:00
- `/calendar`, `/event`, `/draft`, `/mac` — local Mac integrations

The persistent Telegram keyboard keeps common actions one tap away. A text sent while Codex is working steers the active turn; after it finishes, the next text starts a new turn in the same thread.

## Voice messages

Install the local transcription dependency in a dedicated Python environment and set `WHISPER_PYTHON` to its interpreter. The default model is `mlx-community/whisper-large-v3-turbo`.

The bot returns sender/date metadata when Telegram provides it, concise bullets, and a structured transcript with semantic bold emphasis. Audio is processed in a temporary directory and removed afterward. It is not sent into Codex and does not create a project conversation.

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
