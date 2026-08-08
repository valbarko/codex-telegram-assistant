import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  formatArchiveUpsertResult,
  prepareChatGptConversations,
  prepareClaudeConversations,
  prepareMarkdownDocument,
  prepareTelegramExport,
  upsertArchiveDocuments,
} from "./archive-import.js";
import { readConfiguration } from "./configuration.js";
import { MemoryService } from "./memory-service.js";
import { AssistantDatabase } from "./storage.js";

const execute = promisify(execFile);
const configuration = readConfiguration();
const owner = configuration.appleNotesImportOwner;
if (!owner) throw new Error("A single full-access Telegram owner or APPLE_NOTES_IMPORT_OWNER_ID is required");

const telegramPath = option("--telegram");
const claudePath = option("--claude");
const chatGptPath = option("--chatgpt");
const markdownPath = option("--markdown");
if (!telegramPath && !claudePath && !chatGptPath && !markdownPath) {
  throw new Error(
    "Usage: npm run memory:import -- --telegram /path/result.json --claude /path/export.zip " +
    "--chatgpt /path/export.zip --markdown /path/document.md",
  );
}

const database = new AssistantDatabase(path.join(configuration.dataDirectory, "assistant.sqlite"));
try {
  const memory = new MemoryService(configuration.dataDirectory, configuration.memsearchExecutable, database);
  const changed = [];
  if (telegramPath) {
    const prepared = prepareTelegramExport(await readFile(path.resolve(telegramPath), "utf8"));
    console.log(`Telegram подготовлен: ${prepared.chats} чатов, ${prepared.ownMessages} собственных сообщений, ` +
      `${prepared.importedMessages} содержательных сообщений, ${prepared.documents.length} пакетов, ` +
      `${prepared.skippedDuplicate} точных дублей пропущено`);
    const imported = await upsertArchiveDocuments(owner, prepared.documents, memory);
    changed.push(...imported.changedEvents);
    console.log(formatArchiveUpsertResult("Telegram", imported));
  }
  if (claudePath) {
    const conversations = await unzipEntry(path.resolve(claudePath), "conversations.json");
    const prepared = prepareClaudeConversations(conversations);
    console.log(`Claude подготовлен: ${prepared.conversations} чатов, ${prepared.userMessages} пользовательских и ` +
      `${prepared.assistantMessages} ответов ассистента, ${prepared.skippedWithoutVisibleText} технических сообщений пропущено`);
    const imported = await upsertArchiveDocuments(owner, prepared.documents, memory);
    changed.push(...imported.changedEvents);
    console.log(formatArchiveUpsertResult("Claude", imported));
  }
  if (chatGptPath) {
    const archive = path.resolve(chatGptPath);
    const entries = (await zipEntries(archive)).filter((entry) => /^conversations-\d+\.json$/.test(entry)).sort();
    if (!entries.length) throw new Error("ChatGPT archive does not contain conversations-NNN.json files");
    const prepared = prepareChatGptConversations(await readZipEntries(archive, entries));
    console.log(`ChatGPT подготовлен: ${prepared.conversations} чатов, ${prepared.userMessages} пользовательских сообщений, ` +
      `${prepared.importedMessages} содержательных сообщений, ${prepared.documents.length} пакетов, ` +
      `${prepared.skippedDuplicate} точных дублей, ${prepared.skippedAssistant} видимых ответов ChatGPT и ` +
      `${prepared.skippedHiddenOrTechnical} скрытых или технических сообщений пропущено, ` +
      `${prepared.skippedAttachmentParts} вложений пропущено`);
    const imported = await upsertArchiveDocuments(owner, prepared.documents, memory);
    changed.push(...imported.changedEvents);
    console.log(formatArchiveUpsertResult("ChatGPT", imported));
  }
  if (markdownPath) {
    const file = path.resolve(markdownPath);
    const fileStat = await stat(file);
    if (!fileStat.isFile()) throw new Error(`Markdown path is not a file: ${file}`);
    const prepared = prepareMarkdownDocument(file, await readFile(file, "utf8"), fileStat.mtimeMs);
    console.log(`Markdown подготовлен: ${path.basename(file)}, ${prepared.characters} символов`);
    const imported = await upsertArchiveDocuments(owner, prepared.documents, memory);
    changed.push(...imported.changedEvents);
    console.log(formatArchiveUpsertResult("Markdown", imported));
  }
  if (changed.length) {
    console.log(`Перестраивается локальный индекс по ${changed.length} новым или изменённым документам…`);
    await memory.finalizeExternalImport(owner, changed);
  }
  console.log("Импорт архивов завершён");
} finally {
  database.close();
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${name} requires a file path`);
  return value;
}

async function unzipEntry(archive: string, entry: string): Promise<string> {
  const { stdout } = await execute("/usr/bin/unzip", ["-p", archive, entry], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!stdout.trim()) throw new Error(`Archive does not contain ${entry}`);
  return stdout;
}

async function zipEntries(archive: string): Promise<string[]> {
  const { stdout } = await execute("/usr/bin/unzip", ["-Z1", archive], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

async function readZipEntries(archive: string, entries: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  for (const entry of entries) result.push(await unzipEntry(archive, entry));
  return result;
}
