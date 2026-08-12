import path from "node:path";

import Database from "better-sqlite3";

import { ArticleIdeaService, isArticleIdeaRequest } from "./article-idea.js";
import { readConfiguration } from "./configuration.js";
import { CodexHub } from "./codex-engine.js";
import { parseSpokenVoiceCommand } from "./voice-writing.js";

interface MemoryRow {
  id: string;
  role: string;
  body: string;
  created_at: number;
  deleted_at?: number;
}

const ids = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
if (!ids.length) throw new Error("Передайте один или несколько ID записей memory_events");

const configuration = readConfiguration();
const databasePath = path.join(configuration.dataDirectory, "assistant.sqlite");
const database = new Database(databasePath, { readonly: true });
const hub = new CodexHub(configuration);
const service = new ArticleIdeaService(configuration, hub);

try {
  for (const id of ids) {
    const row = database.prepare("SELECT id,role,body,created_at,deleted_at FROM memory_events WHERE id=?")
      .get(id) as MemoryRow | undefined;
    if (!row || row.deleted_at) throw new Error(`Запись памяти не найдена: ${id}`);
    if (row.role !== "user") throw new Error(`Запись не является сообщением пользователя: ${id}`);
    const command = parseSpokenVoiceCommand(row.body);
    const authorCore = command.kind === "assistant" && command.label ? command.content : row.body.trim();
    if (!isArticleIdeaRequest(authorCore)) throw new Error(`Запись не похожа на идею статьи: ${id}`);
    const saved = await service.capture(`backfill:${id}`, authorCore, row.created_at);
    console.log(JSON.stringify(saved));
  }
} finally {
  database.close();
  hub.shutdown();
}
