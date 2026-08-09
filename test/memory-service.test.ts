import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    expect(sanitizeMemoryContent("Ваш секретный ключ\nAQVN0TOcyrVPkN3MLP73IEBSH9NK6vNJ")).toBe("Ваш секретный ключ\n[REDACTED]");
    expect(sanitizeMemoryContent("Доступ: XmETKe6j7BSYq30y4cEv")).toBe("Доступ: [REDACTED]");
    expect(sanitizeMemoryContent("Импорт калорий из FatSecret.")).toBe("Импорт калорий из FatSecret.");
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

  it("uses the matched MemSearch chunk instead of the beginning of a large archive document", async () => {
    let eventId = "";
    const service = new MemoryService(folder, "memsearch", database, async (_executable, args) => {
      if (args[0] !== "search") return "";
      return JSON.stringify([{
        source: `/tmp/${eventId}.md`,
        score: 0.95,
        content: "Релевантный фрагмент из середины большого Telegram-архива",
      }]);
    });
    const event = await service.record({
      owner: "1",
      body: `${"Начало архива. ".repeat(200)}\nРелевантный фрагмент`,
      role: "user",
      kind: "document",
      source: "telegram-export:test",
    });
    eventId = event!.id;

    expect((await service.recall("1", "релевантный"))[0]?.body)
      .toBe("Релевантный фрагмент из середины большого Telegram-архива");
  });

  it("indexes new events incrementally without blocking recall on background indexing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let finishIndex: (() => void) | undefined;
    const calls: string[][] = [];
    const service = new MemoryService(folder, "memsearch", database, async (_executable, args) => {
      calls.push([...args]);
      if (args[0] === "index") await new Promise<void>((resolve) => { finishIndex = resolve; });
      if (args[0] === "search") throw new Error("index is busy");
      return "";
    });
    const event = await service.record({
      owner: "1", body: "Новая запись не должна задерживать ответ", role: "user", kind: "message",
    });

    const recalled = await Promise.race([
      service.recall("1", "задерживать ответ"),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("recall timed out")), 100)),
    ]);

    expect(recalled.map((hit) => hit.body)).toEqual(["Новая запись не должна задерживать ответ"]);
    expect(calls.find((args) => args[0] === "index")?.[1]).toMatch(new RegExp(`${event!.id}\\.md$`));
    finishIndex?.();
    await service.flush("1");
    errors.mockRestore();
  });

  it("mirrors source events to derived knowledge and uses local knowledge recall in prompts", async () => {
    const knowledge = {
      capture: vi.fn(),
      remove: vi.fn(),
      recall: vi.fn(async () => [{
        id: "fact-1",
        text: "Валентин предпочитает сначала увидеть конкретный результат.",
        type: "observation",
        score: 0.9,
      }]),
      reflect: vi.fn(async () => undefined),
      status: vi.fn(() => "Hindsight: готов"),
    };
    const service = new MemoryService(folder, "/missing/memsearch", database, async () => "[]", knowledge);
    const event = await service.record({
      owner: "1", body: "Сначала покажи результат", role: "user", kind: "message", source: "telegram-text",
    });

    expect(knowledge.capture).toHaveBeenCalledWith(event);
    expect(await service.augmentPrompt("1", "Как построить ответ?")).toContain("конкретный результат");
    expect(service.status("1")).toContain("Hindsight: готов");
    expect(await service.forget("1", event!.id)).toBe(true);
    expect(knowledge.remove).toHaveBeenCalledWith(expect.objectContaining({ id: event!.id }));
  });

  it("maintains compact ABOUT and NOW views from confirmed facts and operational state", async () => {
    const service = new MemoryService(folder, "/missing/memsearch", database, async () => "[]");
    database.upsertPersonalFact({
      id: "project:trainer",
      owner: "1",
      category: "project",
      statement: "Развивает продукт «Тренер в кармане»",
      subject: "Валентин",
      predicate: "develops",
      object: "Тренер в кармане",
      status: "current",
      confidence: 1,
      source: "telegram-export:test",
      evidenceMemoryId: "memory-1",
      validFrom: Date.parse("2026-07-11T00:00:00Z"),
      observedAt: Date.parse("2026-07-29T00:00:00Z"),
    });
    await service.record({
      owner: "1", body: "Предпочитаю краткие ответы с конкретными действиями", role: "user", kind: "explicit",
      source: "telegram-remember",
    });
    database.createTask({ owner: "1", title: "Подготовить импорт Apple Notes", dueAt: Date.parse("2026-08-01T09:00:00Z") });
    database.createAlarm({
      owner: "1", label: "Проверить импорт памяти", nextAt: Date.parse("2026-08-02T09:00:00Z"), cadence: "once",
    });

    const views = await service.personalContext("1");

    expect(views.about).toContain("## Проекты");
    expect(views.about).toContain("Тренер в кармане");
    expect(views.about).toContain("уверенность 100%");
    expect(views.about).toContain("memory_id: memory-1");
    expect(views.about).toContain("Предпочитаю краткие ответы");
    expect(views.now).toContain("Подготовить импорт Apple Notes");
    expect(views.now).toContain("Проверить импорт памяти");
    expect(readFileSync(path.join(views.directory, "ABOUT.md"), "utf8")).toBe(views.about);
    expect(readFileSync(path.join(views.directory, "NOW.md"), "utf8")).toBe(views.now);
  });
});
