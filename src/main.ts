import path from "node:path";

import { readConfiguration } from "./configuration.js";
import { CodexHub } from "./codex-engine.js";
import { MemoryService } from "./memory-service.js";
import { BackgroundScheduler } from "./scheduler.js";
import { AssistantDatabase } from "./storage.js";
import { TelegramApplication } from "./telegram-app.js";

const configuration = readConfiguration();
const database = new AssistantDatabase(path.join(configuration.dataDirectory, "assistant.sqlite"));
database.alignDailyDigests(nextLocalTime(6, 0), nextLocalTime(9, 0));
const hub = new CodexHub(configuration);
const memory = new MemoryService(configuration.dataDirectory, configuration.memsearchExecutable, database);
for (const event of database.reportExcludedMemoryEvents()) await memory.forget(event.owner, event.id);
const telegram = new TelegramApplication(configuration, hub, database, memory);
const scheduler = new BackgroundScheduler(configuration, database, hub, telegram.bot, memory);

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping after ${signal}`);
  scheduler.stop();
  telegram.stop();
  hub.shutdown();
  database.close();
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

console.log("Codex Telegram Assistant starting");
console.log(`Data: ${configuration.dataDirectory}`);
scheduler.start();
await telegram.start();

function nextLocalTime(hours: number, minutes: number): number {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
  return date.getTime();
}
