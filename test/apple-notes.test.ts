import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AppleNotesImporter,
  appleNoteSource,
  parseAppleNotes,
  type AppleNoteDocument,
} from "../src/apple-notes.js";
import { MemoryService } from "../src/memory-service.js";
import { AssistantDatabase } from "../src/storage.js";

describe("Apple Notes", () => {
  let folder: string;
  let database: AssistantDatabase;
  let memory: MemoryService;
  let notes: AppleNoteDocument[];

  beforeEach(() => {
    folder = mkdtempSync(path.join(tmpdir(), "cta-apple-notes-"));
    database = new AssistantDatabase(path.join(folder, "assistant.sqlite"));
    memory = new MemoryService(folder, "memsearch", database, vi.fn(async () => "[]"));
    notes = [
      note({ externalId: "note-1", title: "Планы", plaintext: "Поехать в Китай", modifiedAt: 200 }),
      note({ externalId: "note-2", title: "Секрет", plaintext: "Личное", passwordProtected: true }),
      note({ externalId: "note-3", title: "Общая", plaintext: "Чужой текст", shared: true }),
      note({ externalId: "note-4", title: "Удалённая", plaintext: "Старое", folderPath: ["Недавно удалённые"] }),
      note({ externalId: "note-5", title: "Пустая", plaintext: "   " }),
    ];
  });

  afterEach(async () => {
    await memory.flush("1");
    database.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it("parses the structured Notes bridge response", () => {
    expect(parseAppleNotes(JSON.stringify({ version: 1, notes: [{
      externalId: "x-coredata://note/1",
      account: "iCloud",
      folderPath: ["Личное", "Идеи"],
      title: "Проект",
      plaintext: "Текст",
      createdAt: 100,
      modifiedAt: 200,
      passwordProtected: false,
      shared: false,
    }] }))).toEqual([{
      externalId: "x-coredata://note/1",
      account: "iCloud",
      folderPath: ["Личное", "Идеи"],
      title: "Проект",
      plaintext: "Текст",
      createdAt: 100,
      modifiedAt: 200,
      passwordProtected: false,
      shared: false,
    }]);
  });

  it("imports private notes incrementally and skips protected, shared, deleted, and empty notes", async () => {
    const importer = new AppleNotesImporter({
      enabled: true, owner: "1", intervalMs: 86_400_000, includeProtected: false,
    }, memory, async () => notes);

    expect(await importer.sync()).toMatchObject({
      scanned: 5,
      created: 1,
      updated: 0,
      skippedProtected: 1,
      skippedShared: 1,
      skippedDeleted: 1,
      skippedEmpty: 1,
    });
    await memory.flush("1");
    const first = database.memoryEvents("1");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: "document",
      source: appleNoteSource("note-1"),
      createdAt: 200,
    });
    expect(first[0]?.body).toContain("Поехать в Китай");

    expect(await importer.sync()).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    notes = notes.map((item) => item.externalId === "note-1"
      ? { ...item, plaintext: "Поехать в Китай осенью", modifiedAt: 300 }
      : item);
    expect(await importer.sync()).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    await memory.flush("1");
    expect(database.memoryEvents("1")).toHaveLength(1);
    expect(database.memoryEvents("1")[0]).toMatchObject({ id: first[0]?.id, createdAt: 300 });
    expect(database.memoryEvents("1")[0]?.body).toContain("осенью");
  });

  it("imports a protected note only after explicit opt-in and when Notes exposes plaintext", async () => {
    const importer = new AppleNotesImporter({
      enabled: true, owner: "1", intervalMs: 86_400_000, includeProtected: true,
    }, memory, async () => [notes[1]!]);

    expect(await importer.sync()).toMatchObject({ created: 1, skippedProtected: 0 });
    expect(database.memoryEvents("1")[0]?.body).toContain("Личное");
  });
});

function note(overrides: Partial<AppleNoteDocument>): AppleNoteDocument {
  return {
    externalId: "note",
    account: "iCloud",
    folderPath: ["Заметки"],
    title: "Заметка",
    plaintext: "Текст",
    createdAt: 100,
    modifiedAt: 100,
    passwordProtected: false,
    shared: false,
    ...overrides,
  };
}
