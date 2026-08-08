import path from "node:path";

import { AppleNotesImporter, formatAppleNotesImportResult } from "./apple-notes.js";
import { readConfiguration } from "./configuration.js";
import { CodexHub } from "./codex-engine.js";
import { HindsightKnowledgeService } from "./hindsight-service.js";
import { MemoryService } from "./memory-service.js";
import { BackgroundScheduler } from "./scheduler.js";
import { AssistantDatabase } from "./storage.js";
import { TelegramApplication } from "./telegram-app.js";

const configuration = readConfiguration();
const database = new AssistantDatabase(path.join(configuration.dataDirectory, "assistant.sqlite"));
database.alignDailyDigests(nextLocalTime(6, 0), nextLocalTime(6, 0));
const hub = new CodexHub(configuration);
const hindsight = new HindsightKnowledgeService(configuration);
const memory = new MemoryService(configuration.dataDirectory, configuration.memsearchExecutable, database, undefined, hindsight);
const appleNotes = new AppleNotesImporter({
  enabled: configuration.appleNotesImportEnabled,
  owner: configuration.appleNotesImportOwner,
  intervalMs: configuration.appleNotesImportIntervalMs,
  includeProtected: configuration.appleNotesImportProtected,
}, memory);
for (const event of database.reportExcludedMemoryEvents()) await memory.forget(event.owner, event.id);
const telegram = new TelegramApplication(configuration, hub, database, memory);
const scheduler = new BackgroundScheduler(configuration, database, hub, telegram.bot, memory);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping after ${signal}`);
  appleNotes.stop();
  scheduler.stop();
  telegram.stop();
  hub.shutdown();
  await hindsight.flush().catch((error) => console.error("Hindsight final flush failed", error));
  database.close();
  process.exit(0);
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

console.log("Codex Telegram Assistant starting");
console.log(`Data: ${configuration.dataDirectory}`);
scheduler.start();
void appleNotes.start()
  .then((result) => { if (result) console.log(formatAppleNotesImportResult(result)); })
  .catch((error) => console.error("Initial Apple Notes import failed", error));
await telegram.start();

function nextLocalTime(hours: number, minutes: number): number {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
  return date.getTime();
}
