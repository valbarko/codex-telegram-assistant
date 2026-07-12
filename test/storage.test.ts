import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AssistantDatabase } from "../src/storage.js";

describe("AssistantDatabase", () => {
  let folder: string;
  let database: AssistantDatabase;
  beforeEach(() => { folder = mkdtempSync(path.join(tmpdir(), "cta-db-")); database = new AssistantDatabase(path.join(folder, "assistant.sqlite")); });
  afterEach(() => { database.close(); rmSync(folder, { recursive: true, force: true }); });

  it("stores tasks and a stable FIFO queue", () => {
    const first = database.createTask({ owner: "1", title: "Первая" });
    const second = database.createTask({ owner: "1", title: "Вторая" });
    database.enqueue(first.id); database.enqueue(second.id);
    expect(database.queued()?.id).toBe(first.id);
    database.updateTask(first.id, { status: "done" });
    expect(database.queued()?.id).toBe(second.id);
  });

  it("searches Unicode text across tasks, captures and memory", () => {
    database.createTask({ owner: "1", title: "Позвонить Анне" });
    database.capture({ owner: "1", kind: "voice", body: "Обсудили договор", state: "memory" });
    database.remember("1", "Анна ждёт договор");
    expect(database.search("1", "ПОЗВОНИТЬ").map((hit) => hit.type)).toEqual(["task"]);
    expect(database.search("1", "ДОГОВОР").length).toBe(2);
  });

  it("persists conversation ownership", () => {
    database.saveConversation({ context: "1:42", threadId: "thr", workspace: "/work", model: "gpt", profileId: "review" });
    expect(database.conversation("1:42")).toMatchObject({ threadId: "thr", workspace: "/work", profileId: "review" });
  });
});
