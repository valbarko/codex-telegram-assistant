# Delayed Telegram → MAX bridge

This source-only bridge copies new posts from `valbarkoclub` into
`channel_valbarko`. Valentin authorized this standing operation on 2026-11-08.
The completed historical migration is the initial baseline, not a new queue.

## Publication policy

- Wait at least 3,600 seconds after the last observed source edit. An edit, media
  replacement or album addition restarts the quiet period. Catch-up posts also
  receive a full quiet period after first observation.
- Preserve source order and collect the whole album. Source text is never
  rewritten by a language model. Custom emoji use the verified historical
  transcription where known, otherwise the source Unicode alternative.
- Create no more than one MAX message per hour, including continuation parts.
  A recent manually published MAX post also reserves that hour.
- Copy supported text, photo, video, video-note, animation, audio, voice,
  document and poll content. MAX compatibility is the same as the verified
  migration: quoted text uses italics, spoilers are visible, polls are static
  question/options/results, and WAV remains an unchanged file.
- Retain the historical source-to-MAX map and rewrite links to known migrated
  posts. Reconcile internal links and continuation links as new targets appear.
- Later edits of posts created by this bridge update the known MAX IDs after
  another quiet hour. Shape changes that would require removing published
  parts or album members stop for review. The bridge never deletes MAX posts.
- A deleted pending Telegram post is cancelled. A deleted already-published
  source does not cause a MAX deletion.

## Processes and state

The dedicated TDLib **bot** session uses the existing Telegram bot identity and
a separate encrypted database under `ASSISTANT_DATA_DIR/telegram-max/source-bot`.
It does not start another Bot API `getUpdates` poller or change the assistant.
The bot is a source-channel administrator with `can_manage_chat` only; it cannot
post, edit, delete, invite, pin, or promote administrators in Telegram.

Only that one channel is admitted into the durable inbox. Other chats are
ignored, and the dedicated session disables message, chat-info and file databases.
TDLib credentials are loaded from the existing Keychain setup. The bot token
stays in memory, loaded through `readConfiguration()`.

After startup and long sleep/network gaps, `catchup.mts` reads authoritative
channel history back to the historical baseline through the existing editorial
user session, then closes it. A failed catch-up blocks publication and retries
through launchd. It never treats incomplete history as an empty queue.

The source process receives edit/deletion updates and validates watched messages
every 25 seconds. Before publishing, the worker requires a fresh source lease,
rechecks source versions after uploads, and verifies the MAX hourly interval.

`worker.py` uses a kernel lock, atomic JSON replacements and `fsync`. Before a
public write, the outbox stores the exact expected text/markup, media hashes and
operation. Upload tokens and upload URLs are never persisted. Receipts require a
fresh MAX read-back with exact text, markup, destination, attachment order and
stable attachment identity. Ambiguous writes retain their outbox and cannot be
blindly retried. A lost create response for a media post requires manual review.
After six repeated failures before a message write, the worker pauses for review.
The owner receives a concise operational alert when the worker is blocked.

MAX transport reuses the locally installed `publish-valentin-article` adapter's
account selector, Keychain token and adapter-only TLS certificate. The bridge
requires `write`, `edit`, and `read_all_messages`; it does not grant more MAX rights.

## Operation

Initial installation (the archive and state are private, excluded from Git):

```sh
rtk proxy python3 -B scripts/telegram-max/install.py \
  --root "$HOME/.local/share/codex-telegram-assistant/telegram-max" \
  --archive .private/audits/max-migration-2026-11-07 \
  --owner-id OWNER_TELEGRAM_ID
```

The service is `com.valbarko.telegram-max`, independent of both the assistant and
the retired archive-migration jobs. It starts at login and restarts after crashes.
It runs on this Mac; sleep/offline time delays publication, and catch-up preserves
the queue after wake. It does not keep the Mac awake or change system power settings.

Safe status sources inside the private state directory:

- `settings.json`: standing authorization, exact destinations, baseline, delays;
- `source-ready.json`: source freshness, connection and catch-up confirmation;
- `worker-health.json`: idle/waiting/published/blocked state;
- `state.json`: durable queue, source map, verified receipts and unresolved outbox;
- `journal.jsonl`: sanitized events; `source.log` / `source-error.log`: lifecycle.

To pause, atomically set `settings.json` → `enabled` to `false`. To stop only the
bridge while retaining its queue and credentials:

```sh
rtk proxy python3 -B scripts/telegram-max/install.py \
  --root "$HOME/.local/share/codex-telegram-assistant/telegram-max" --remove
```

Never clear an outbox to retry. First find and verify the actual MAX publication.
For a media response loss, compare its actual attachment with the retained source;
then attach the verified message ID to the outbox and let the read-back complete.
Clear `paused_error` only after fixing the exact issue and inspecting external state.

## Verification

```sh
rtk proxy python3 -B -m unittest discover -s scripts/telegram-max -p 'test_*.py' -v
rtk proxy npx vitest run test/telegram-max-source.test.ts
```

The dedicated GitHub Actions workflow runs these checks and TypeScript checking
for the standalone source/catch-up tools. No credentials or live writes are used
in tests. Production smoke verifies both real identities, source-channel rights,
authoritative catch-up, MAX connection and fresh idle-worker health. No artificial
test posts are added to either public channel.
