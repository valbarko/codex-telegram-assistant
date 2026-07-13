# Codex Telegram Assistant — Product Roadmap

The product already has enough foundational commands. The next stage is to make it a reliable mobile control surface for Codex and the owner's daily work rather than expanding the command list.

## Next delivery package

### 1. Unified runtime card

Keep one Telegram message updated throughout a Codex run. It should show:

- current action;
- project and thread;
- current stage;
- elapsed time;
- whether Codex is waiting for approval or an answer;
- buttons to stop the run, show details, or open the thread on the Mac.

Tool events should be summarized in this card instead of being accepted silently or emitted as noisy individual messages.

### 2. Staged attachments and artifact return

Treat forwarded documents and photos as a staged package:

1. Save the package locally.
2. Offer actions to analyze it, attach it to the next request, keep it, or delete it.
3. Pass only explicitly selected files to Codex.
4. Return files created by Codex to Telegram when safe and within Telegram limits.

This flow is intended for client documents, research, spreadsheets, and product materials.

### 3. Restart recovery

Persist enough runtime state to recover honestly after a process restart:

- pending approvals;
- unanswered Codex questions;
- running or interrupted tasks;
- runtime-card message IDs and last rendered state;
- staged attachments.

After restart, resume recoverable work. When exact continuation is impossible, update the existing card or send one clear notice explaining what was interrupted and what the user can do next.

## Daily plan at 06:00

Send a single morning plan every day at **06:00 in the configured local timezone**. The initial personal deployment uses `Europe/Moscow`.

The plan should contain:

- today's weather: temperature, precipitation, and wind;
- calendar events in chronological order;
- overdue tasks, tasks due today, and the three highest priorities;
- today's client sessions and preparation or follow-up actions;
- schedule conflicts and useful free windows;
- buttons to refresh the plan, add a task, and open the day on the Mac.

The digest is an aggregator: failure of weather, calendar, tasks, or client data must not prevent the remaining sections from being delivered. A failed source is represented by one concise status line.

### Client data rollout

1. Use Apple Calendar as the first source for client sessions.
2. Add a read-only connector to the client database for richer context such as the next contact, missed sessions, payment follow-ups, and important dates.
3. Use Calendar as a fallback whenever the client connector is unavailable.

Telegram output must contain only the minimum working context. Health information and detailed private client notes must not appear in the morning plan.

## Later product improvements

### System alarm lifecycle

- Add `/alarms` for system and Telegram alarms.
- Support “Snooze for 10 minutes”.
- Delete a paired alarm from both Clock and Telegram.
- Support weekday recurrence.
- Preserve clear human-readable labels such as “Клиент Анна”, “Тренировка”, and “Оплата”.

### Plan approval mode

For large requests, let Codex prepare a read-only plan first. Present it as one card with “Execute”, “Edit”, and “Cancel” actions. Start mutations only after explicit confirmation.

### Natural-language routing

Route requests to tasks, Calendar, Gmail and Apple Mail drafts, memory, alarms, or scheduled Codex jobs. Always return a receipt that states what was created or prepared, where it lives, and when it will run.

### Smart notifications

Separate notifications into decisions required, successful completion, failure, approaching deadlines, morning plans, and evening summaries. Support quiet hours and do-not-disturb behavior.

## Explicit non-goals for now

- multiple AI providers;
- multi-user operation;
- a separate web dashboard;
- complex autonomous multi-agent orchestration;
- becoming a general-purpose automation platform such as n8n or OpenClaw.

## Delivery order

1. Unified runtime card.
2. Staged attachments and artifact return.
3. Restart recovery.
4. Morning daily plan at 06:00.
5. Alarm lifecycle, plan approval, natural routing, and smart-notification refinements.
