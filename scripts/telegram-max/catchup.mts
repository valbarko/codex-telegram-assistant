/** Authoritative source-only catch-up after downtime. No external writes. */
import path from 'node:path';
import {readFile, writeFile, rename} from 'node:fs/promises';
import {readConfiguration} from '../../src/configuration.ts';
import {loadTelegramReaderCredentials} from '../../src/telegram-reader-keychain.ts';
import {TelegramChannelReader} from '../../src/telegram-reader.ts';

const root = process.argv[2];
if (!root) throw Error('Private state directory required');
const settings = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
const cfg = readConfiguration();
const credentials = await loadTelegramReaderCredentials();
if (!credentials) throw Error('Telegram reader is unavailable');
const reader = new TelegramChannelReader(credentials, path.join(cfg.dataDirectory, 'telegram-reader'));
const timeout = setTimeout(() => process.exit(2), 90_000);
let chatId: number | undefined;
try {
  await reader.login({getPhoneNumber: async () => {throw Error('Login required');},
    getAuthCode: async () => {throw Error('Login required');}, getPassword: async () => {throw Error('Login required');}});
  const access = await reader.channelAccess('valbarkoclub');
  if (access.chatId !== settings.source_chat) throw Error('Unexpected source');
  chatId = access.chatId;
  const client = (reader as any).client;
  await client.invoke({_: 'openChat', chat_id: chatId});
  await new Promise(resolve => setTimeout(resolve, 1000));
  const messages = new Map<number, any>();
  let cursor = 0;
  let complete = false;
  let stalled = 0;
  for (let page = 0; page < 500; page++) {
    const response = await client.invoke({_: 'getChatHistory', chat_id: chatId,
      from_message_id: cursor, offset: 0, limit: 100, only_local: false});
    const items = response.messages || [];
    if (!items.length) {
      // Empty first responses can be a not-yet-loaded cache. Retry, never
      // incorrectly declare that an unverified channel has no new messages.
      if (!cursor && page < 3) {await new Promise(resolve => setTimeout(resolve, 1000)); continue;}
      if (cursor) {complete = true; break;}
      throw Error('Source history unavailable');
    }
    for (const message of items) {
      if (message.id / 1048576 > settings.baseline_id) messages.set(message.id, message);
      else complete = true;
    }
    if (complete) break;
    const next = items.at(-1).id;
    if (cursor === next) {
      if (++stalled<=3) {await new Promise(resolve=>setTimeout(resolve,750));continue;}
      throw Error('Source history stalled before baseline');
    }
    stalled=0;
    cursor = next;
  }
  if (!complete) throw Error('Source history did not reach the archive baseline');
  const temporary = path.join(root, 'catchup.json.tmp');
  await writeFile(temporary, JSON.stringify({at: Date.now()/1000, source_chat: chatId,
    complete, messages: [...messages.values()].sort((a,b) => a.id-b.id)}), {mode: 0o600});
  await rename(temporary, path.join(root, 'catchup.json'));
  console.log(JSON.stringify({complete, new_messages: messages.size}));
} catch {
  console.error('Source catch-up unavailable; publication remains blocked');
  process.exitCode = 1;
} finally {
  if (chatId) await (reader as any).client.invoke({_: 'closeChat', chat_id: chatId}).catch(() => undefined);
  await reader.close();
  clearTimeout(timeout);
}
