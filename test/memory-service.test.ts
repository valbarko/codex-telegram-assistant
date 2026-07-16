import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryService, sanitizeMemoryContent } from "../src/memory-service.js";
import { AssistantDatabase } from "../src/storage.js";

describe("MemoryService", () => {
  let folder: string;
  let database: AssistantDatabase;
  beforeEach(() => { folder = mkdtempSync(path.join(tmpdir(), "cta-memory-")); database = new AssistantDatabase(path.join(folder, "assistant.sqlite")); });
  afterEach(() => { database.close(); rmSync(folder, { recursive: true, force: true }); });

  it("redacts credentials and rejects standalone OTP values", () => {
    expect(sanitizeMemoryContent("мой пароль: hunter2, проект важный")).toBe("мой пароль: [REDACTED], проект важный");
    expect(sanitizeMemoryContent("sk-proj_abcdefghijklmnopqrstuvwxyz123456")).toBeUndefined();
    expect(sanitizeMemoryContent("482913")).toBeUndefined();
  });

  it("falls back to scoped lexical recall and forgets exact records", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new MemoryService(folder, "/missing/memsearch", database, async () => { throw new Error("offline"); });
    const global = await service.record({ owner: "1", body: "Валентин предпочитает короткие ответы", role: "user", kind: "message" });
    await service.record({ owner: "1", body: "В проекте ТРЕНЕР нужен недельный отчёт", role: "user", kind: "message", project: "/work/trainer" });
    await service.record({ owner: "1", body: "В проекте ДЕНЬГИ нужен бюджет", role: "user", kind: "message", project: "/work/money" });

    const trainer = await service.recall("1", "недельный отчёт", "/work/trainer");
    expect(trainer.map((hit) => hit.body)).toEqual(["В проекте ТРЕНЕР нужен недельный отчёт"]);
    expect(service.status("1")).toContain("MemSearch: временно недоступен");
    expect(service.status("1")).not.toContain("offline");
    expect(errors).toHaveBeenCalled();
    expect(await service.augmentPrompt("1", "какие ответы я предпочитаю?", "/work/trainer")).toContain("короткие ответы");
    expect(await service.forget("1", global!.id)).toBe(true);
    expect(await service.recall("1", "короткие ответы", "/work/trainer")).toEqual([]);
    errors.mockRestore();
  });

  it("honors pause for capture and recall", async () => {
    const service = new MemoryService(folder, "/missing/memsearch", database, async () => "[]");
    service.setPaused("1", true);
    expect(await service.record({ owner: "1", body: "Не сохранять", role: "user", kind: "message" })).toBeUndefined();
    expect(await service.recall("1", "сохранять")).toEqual([]);
  });
});
