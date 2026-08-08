import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  prepareChatGptConversations,
  prepareClaudeConversations,
  prepareMarkdownDocument,
  prepareTelegramExport,
  upsertArchiveDocuments,
} from "../src/archive-import.js";
import { MemoryService } from "../src/memory-service.js";
import { AssistantDatabase } from "../src/storage.js";

describe("archive import", () => {
  let folder: string;
  let database: AssistantDatabase;

  beforeEach(() => {
    folder = mkdtempSync(path.join(tmpdir(), "cta-archive-"));
    database = new AssistantDatabase(path.join(folder, "assistant.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it("keeps only substantive self-authored Telegram messages and batches stable rich text", () => {
    const prepared = prepareTelegramExport(JSON.stringify({
      personal_information: { user_id: 42 },
      chats: { list: [{
        id: 7,
        name: "Диалог",
        type: "personal_chat",
        messages: [
          { id: 1, type: "message", from_id: "user42", date: "2026-01-02T10:00:00", date_unixtime: "1767348000", text: "Моя мысль" },
          { id: 2, type: "message", from_id: "user9", date: "2026-01-02T10:01:00", date_unixtime: "1767348060", text: "Чужая мысль" },
          { id: 3, type: "message", from_id: "user42", date: "2026-01-02T10:02:00", date_unixtime: "1767348120",
            text: ["Хочу ", { type: "bold", text: "поехать" }] },
          { id: 4, type: "message", from_id: "user42", date: "2026-01-02T10:03:00", date_unixtime: "1767348180", text: "ок" },
          { id: 5, type: "message", from_id: "user42", date: "2026-02-02T10:00:00", date_unixtime: "1770026400", text: "Моя мысль" },
        ],
      }] },
    }), 120);

    expect(prepared).toMatchObject({
      chats: 1,
      ownMessages: 4,
      importedMessages: 2,
      skippedTrivial: 1,
      skippedDuplicate: 1,
    });
    expect(prepared.documents).toHaveLength(1);
    expect(prepared.documents.map((document) => document.body).join("\n")).toContain("Хочу поехать");
    expect(prepared.documents.map((document) => document.body).join("\n")).not.toContain("Чужая мысль");
    expect(new Set(prepared.documents.map((document) => document.source)).size).toBe(1);
  });

  it("imports only visible Claude text and keeps assistant replies as assistant role", () => {
    const prepared = prepareClaudeConversations(JSON.stringify([{
      uuid: "conversation-1",
      name: "Планы",
      created_at: "2026-07-01T10:00:00Z",
      chat_messages: [
        { uuid: "message-1", sender: "human", created_at: "2026-07-01T10:00:00Z", text: "Хочу запустить проект", content: [] },
        { uuid: "message-2", sender: "assistant", created_at: "2026-07-01T10:01:00Z", text: "", content: [
          { type: "thinking", thinking: "скрытое рассуждение" },
          { type: "tool_use", input: { query: "секретный вызов" } },
          { type: "text", text: "Начни с небольшого теста" },
        ] },
        { uuid: "message-3", sender: "assistant", created_at: "2026-07-01T10:02:00Z", text: "", content: [
          { type: "tool_result", content: "технический результат" },
        ] },
      ],
    }]));

    expect(prepared).toMatchObject({
      conversations: 1,
      messages: 3,
      userMessages: 1,
      assistantMessages: 1,
      skippedWithoutVisibleText: 1,
    });
    expect(prepared.documents.map((document) => document.role)).toEqual(["user", "assistant"]);
    expect(prepared.documents[1]?.body).toContain("Начни с небольшого теста");
    expect(prepared.documents[1]?.body).not.toContain("скрытое рассуждение");
    expect(prepared.documents[1]?.body).not.toContain("технический результат");
  });

  it("imports only user-authored text from the current ChatGPT branch", () => {
    const prepared = prepareChatGptConversations([JSON.stringify([{
      id: "conversation-1",
      title: "Планы",
      create_time: 1_783_000_000,
      current_node: "user-2",
      mapping: {
        root: { id: "root", parent: null, message: null },
        "user-1": {
          id: "user-1",
          parent: "root",
          message: {
            id: "message-1",
            author: { role: "user" },
            create_time: 1_783_000_001,
            content: { content_type: "text", parts: ["Хочу запустить личную память"] },
          },
        },
        thought: {
          id: "thought",
          parent: "user-1",
          message: {
            id: "message-2",
            author: { role: "assistant" },
            create_time: 1_783_000_002,
            content: { content_type: "thoughts", parts: ["скрытое рассуждение"] },
          },
        },
        answer: {
          id: "answer",
          parent: "thought",
          message: {
            id: "message-3",
            author: { role: "assistant" },
            create_time: 1_783_000_003,
            content: { content_type: "text", parts: ["Ответ ChatGPT"] },
          },
        },
        "user-2": {
          id: "user-2",
          parent: "answer",
          message: {
            id: "message-4",
            author: { role: "user" },
            create_time: 1_783_000_004,
            content: {
              content_type: "multimodal_text",
              parts: ["Добавь мои заметки", { content_type: "image_asset_pointer", asset_pointer: "file-service://secret" }],
            },
          },
        },
        branch: {
          id: "branch",
          parent: "user-1",
          message: {
            id: "message-5",
            author: { role: "user" },
            create_time: 1_783_000_005,
            content: { content_type: "text", parts: ["Заброшенная ветка"] },
          },
        },
      },
    }])], 2_000);

    expect(prepared).toMatchObject({
      conversations: 1,
      currentBranchMessages: 4,
      userMessages: 2,
      importedMessages: 2,
      skippedAssistant: 1,
      skippedHiddenOrTechnical: 1,
      skippedBranchMessages: 1,
      skippedAttachmentParts: 1,
    });
    expect(prepared.documents).toHaveLength(1);
    expect(prepared.documents[0]).toMatchObject({ role: "user", kind: "document" });
    expect(prepared.documents[0]?.body).toContain("Хочу запустить личную память");
    expect(prepared.documents[0]?.body).toContain("Добавь мои заметки");
    expect(prepared.documents[0]?.body).not.toContain("Ответ ChatGPT");
    expect(prepared.documents[0]?.body).not.toContain("скрытое рассуждение");
    expect(prepared.documents[0]?.body).not.toContain("Заброшенная ветка");
    expect(prepared.documents[0]?.body).not.toContain("file-service");
  });

  it("imports a Markdown file as one stable global user document", () => {
    const first = prepareMarkdownDocument(
      "/tmp/product-vision.md",
      "# Тренер в кармане\r\n\r\nПерсональный фитнес-продукт.  \r\n",
      1_783_000_000_000,
    );
    const updated = prepareMarkdownDocument(
      "/tmp/product-vision.md",
      "# Тренер в кармане\n\nОбновлённое видение.",
      1_783_000_100_000,
    );

    expect(first).toMatchObject({ characters: 48 });
    expect(first.documents).toHaveLength(1);
    expect(first.documents[0]).toMatchObject({
      role: "user",
      kind: "document",
      sourceChangedAt: 1_783_000_000_000,
    });
    expect(first.documents[0]?.body).toContain("подтверждённый пользовательский источник");
    expect(first.documents[0]?.body).toContain("Файл: product vision.md");
    expect(first.documents[0]?.body).toContain("# Тренер в кармане\n\nПерсональный фитнес-продукт.");
    expect(first.documents[0]?.source).toBe(updated.documents[0]?.source);
  });

  it("defers one derived-index rebuild until a bulk archive is fully stored", async () => {
    const run = vi.fn(async () => "");
    const memory = new MemoryService(folder, "memsearch", database, run);
    const prepared = prepareClaudeConversations(JSON.stringify([{
      uuid: "conversation-1",
      name: "Планы",
      created_at: "2026-07-01T10:00:00Z",
      chat_messages: [
        { uuid: "message-1", sender: "human", created_at: "2026-07-01T10:00:00Z", text: "Хочу запустить проект" },
        { uuid: "message-2", sender: "assistant", created_at: "2026-07-01T10:01:00Z", text: "Составь план" },
      ],
    }]));

    const imported = await upsertArchiveDocuments("1", prepared.documents, memory);
    expect(imported).toMatchObject({ created: 2, updated: 0, unchanged: 0 });
    expect(run).not.toHaveBeenCalled();
    await memory.finalizeExternalImport("1", imported.changedEvents);
    expect(run).toHaveBeenCalledTimes(1);
    const indexArguments = run.mock.calls[0]?.[1] ?? [];
    expect(indexArguments[0]).toBe("index");
    expect(indexArguments.filter((argument) => argument.endsWith(".md"))).toHaveLength(2);
    expect(database.memoryEvents("1")).toHaveLength(2);
  });
});
