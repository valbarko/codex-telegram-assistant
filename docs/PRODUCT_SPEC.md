# Codex Telegram Assistant — Functional Specification

This document defines observable behavior for an independent implementation. It does not prescribe source structure or reuse code from another Telegram bridge.

## Product boundary

The application is a private-by-default Telegram client for a local Codex installation. It runs continuously on the owner's Mac, talks to `codex app-server` over stdio, and never exposes an inbound network port.

## Required capabilities

### Codex conversations

- Maintain an independent active Codex thread for every Telegram chat or forum topic.
- Create a general conversation without a project and create a project-bound thread.
- List, resume, rename, archive, and fork stored Codex threads.
- Stream assistant text, plan changes, command progress, file changes, MCP calls, and final token usage.
- Interrupt an active turn.
- Treat a new Telegram message during an active turn as steering input for that turn.
- Present command, file, and permission approvals in Telegram with decisions for one action, the session, decline, or cancellation.
- Transfer a thread to the Mac by activating Codex and copying a resume command.

### Projects

- Discover prior workspaces from Codex state.
- Remove generated worktrees and duplicate display names from project selection.
- Support user-defined aliases such as `ТРЕНЕР`, `КЛИЕНТЫ`, and `ДЕНЬГИ`.
- Sort threads and projects by recent activity where activity data exists.

### Personal assistant

- Store tasks, inbox items, reminders, explicit memories, background runs, and settings in a private SQLite database.
- Provide a home dashboard, quick task capture, project assignment, task completion, snoozing, and a serial Codex queue.
- Deliver notifications for task start, completion, failure, and required user action.
- Parse Russian reminder expressions for relative time, today, tomorrow, dates, daily schedules, and weekdays.
- Support scheduled Codex tasks, a morning digest, and a 21:00 cross-project summary built from tasks and long-term memory.
- Search tasks, inbox, memories, voice transcripts, and Codex threads.

### Inputs and artifacts

- Unlabelled voice and audio are transcription-only. A label at the start of a voice or text message routes only that message; there is no persistent voice mode.
- Voice output contains sender/date metadata when Telegram supplies it, concise summary bullets, and a structured transcript with meaningful bold emphasis.
- Rapidly forwarded voice messages from one original sender are buffered for 45 seconds and grouped while consecutive source timestamps remain within 10 minutes. Files are transcribed independently, ordered by source time, and formatted by Codex as one coherent transcript or multiple topic sections. Forwarded speech never executes spoken commands.
- Supported text and spoken labels include post, announcement, reply, diary, story, calendar, task, reminder, inbox/idea, and memory. Diary, story, post, announcement, and reply labels use dedicated read-only Codex editorial threads without modifying the user's active project conversation.
- Post, announcement, and reply labels retrieve relevant examples from an ignored private corpus, apply the versioned authorial profile, and return a ready Telegram draft. Examples influence voice and rhythm only: their facts and distinctive passages must not be copied. Retrieval falls back to the private local JSONL corpus if semantic search is unavailable.
- Diary entries append to one Apple Notes note per month, grouped by date and time. Story entries append to the selected cycle. Both keep untouched transcripts and readable Markdown backups.
- A bare `Diary` or `Notes` label returns the current day's structured entries in Telegram plus a Markdown file. When content follows either label, it is treated as a new diary entry.
- Date/time commands use deterministic parsing first and a validated, read-only Codex JSON extraction fallback second. Calendar writes still require explicit confirmation; ambiguous fallback results ask for clarification.
- Photos may be sent as Codex image inputs.
- Documents may be staged for Codex, with explicit instructions describing their paths.
- Generated artifacts are returned to Telegram when safe and within Telegram limits.
- Codex Markdown is converted to escaped Telegram HTML for both streaming and final messages, with a plain-text fallback when Telegram rejects formatted output.

### Mail and calendar

- Natural-language requests to read, find, or summarize email use the connected Gmail app.
- Reading/searching is allowed; sending, archiving, deleting, or otherwise mutating mail requires explicit confirmation.
- Apple Mail is used only to create a visible draft or as an explicitly requested local fallback.
- Calendar events may be listed locally. Event creation requires a confirmation button.

## Safety and privacy

- Only configured Telegram user IDs may interact with the bot.
- Secrets are loaded from an ignored environment file or process environment and never logged.
- The default execution profile is least privilege.
- Background jobs never auto-approve permission requests.
- Mail is never sent automatically.
- Runtime state, audio model caches, databases, local memory indexes, logs, and user paths are excluded from source control.
- A fallback backend may exist during migration, but the public product targets app-server only.

## Operational requirements

- Run under a user LaunchAgent on macOS and restart after crashes or login.
- Do not depend on the Codex desktop app remaining open.
- Preserve thread/task state across process restarts.
- Provide a health command and backend/version diagnostics.
- Support Node.js 22 or newer.

## Acceptance criteria

- Unit tests cover protocol routing, approvals, streaming, task storage, reminders, access control, and mail intent routing.
- Integration smoke tests cover app-server initialization, thread start, one turn, interrupt/steer, and a declined approval.
- The production LaunchAgent is switched only after the new implementation passes parity smoke tests against the existing deployment.
