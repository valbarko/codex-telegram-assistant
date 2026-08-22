import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  contextModeForQuery,
  MemoryService,
  sanitizeMemoryContent,
  scopedMemorySource,
} from "../src/memory-service.js";
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

  it("deduplicates a replayed Telegram update but preserves an intentional repeated message", async () => {
    const service = new MemoryService(folder, "memsearch", database, async () => "");
    const input = {
      owner: "1",
      body: "Одинаковый текст",
      role: "user" as const,
      kind: "message" as const,
      sourceChangedAt: 1_000,
    };

    const first = await service.upsertExternal({ ...input, source: "telegram-update:100:text;thread=thread-1" });
    const replay = await service.upsertExternal({ ...input, source: "telegram-update:100:text;thread=thread-1" });
    const repeated = await service.upsertExternal({
      ...input, source: "telegram-update:101:text;thread=thread-1", sourceChangedAt: 2_000,
    });
    await service.flush("1");

    expect(first?.status).toBe("created");
    expect(replay).toMatchObject({ status: "unchanged", event: { id: first?.event.id } });
    expect(repeated).toMatchObject({ status: "created", event: { body: "Одинаковый текст" } });
    expect(database.memoryEvents("1")).toHaveLength(2);
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

  it("fuses semantic and lexical ranks and prioritizes hits found by both", async () => {
    const semanticOnly = database.recordMemoryEvent({
      owner: "1", namespace: "project", project: "/work/trainer", role: "user", kind: "message",
      body: "Совсем другой эпизод из кофейни", source: "telegram-export:semantic",
    });
    const hybrid = database.recordMemoryEvent({
      owner: "1", namespace: "project", project: "/work/trainer", role: "user", kind: "message",
      body: "Светлый зал, большие окна и много пространства", source: "telegram-export:hybrid",
    });
    const lexicalOnly = database.recordMemoryEvent({
      owner: "1", namespace: "project", project: "/work/trainer", role: "user", kind: "message",
      body: "Светлый зал понравился", source: "telegram-export:lexical",
    });
    const service = new MemoryService(folder, "memsearch", database, async (_executable, args) => {
      if (args[0] !== "search") return "";
      return JSON.stringify([
        { source: `/tmp/${semanticOnly.id}.md`, score: 0.95, content: semanticOnly.body },
        { source: `/tmp/${hybrid.id}.md`, score: 0.9, content: hybrid.body },
      ]);
    });

    const hits = await service.recall("1", "светлый зал большие окна", "/work/trainer", 3);

    expect(hits[0]).toMatchObject({ id: hybrid.id, retrieval: "hybrid", fusionScore: 1 });
    expect(hits.map((hit) => hit.id)).toContain(semanticOnly.id);
    expect(hits.map((hit) => hit.id)).toContain(lexicalOnly.id);
  });

  it("extracts the matching lexical excerpt from a large archive when semantic search is unavailable", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    database.recordMemoryEvent({
      owner: "1", namespace: "global", role: "user", kind: "document",
      body: [
        ...Array.from({ length: 80 }, (_, index) => `Старая запись номер ${index} без нужной темы.`),
        "### 2026-08-09T10:00:00.000Z · message 42",
        "Мне понравился светлый зал: большие окна и пространство.",
        "После этого идёт другая заметка.",
      ].join("\n"),
      source: "telegram-export:large",
    });
    const service = new MemoryService(folder, "memsearch", database, async () => { throw new Error("offline"); });

    const hit = (await service.recall("1", "светлый зал большие окна", undefined, 1))[0];

    expect(hit?.body).toContain("Мне понравился светлый зал");
    expect(hit?.body).not.toContain("Старая запись номер 0");
    errors.mockRestore();
  });

  it("matches lexical terms as words instead of accidental substrings", async () => {
    database.recordMemoryEvent({
      owner: "1", namespace: "global", role: "user", kind: "message",
      body: "У меня залежалось два банана, поэтому я решила приготовить банановый кекс",
      source: "telegram-export:banana",
    });
    const service = new MemoryService(folder, "memsearch", database, async (_executable, args) =>
      args[0] === "search" ? "[]" : "");

    expect(await service.recall("1", "Что я решил про новый зал?", undefined, 5)).toEqual([]);
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
    expect(await service.augmentPrompt("1", "Как построить ответ?", undefined, { mode: "relevant" }))
      .toContain("конкретный результат");
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

  it("keeps ordinary same-thread messages free from memory payloads", async () => {
    const runCommand = vi.fn(async () => "[]");
    const knowledge = {
      capture: vi.fn(),
      remove: vi.fn(),
      recall: vi.fn(async () => []),
      reflect: vi.fn(async () => undefined),
      status: vi.fn(() => "Hindsight: готов"),
    };
    const service = new MemoryService(folder, "memsearch", database, runCommand, knowledge);
    const query = "Его могу проходить в отпуске? Это считается отдыхом?";

    expect(await service.augmentPrompt("1", query, "/work/trainer", { threadId: "thread-1" })).toBe(query);
    expect(runCommand).not.toHaveBeenCalled();
    expect(knowledge.recall).not.toHaveBeenCalled();
  });

  it("routes only explicit historical and operational questions to context", () => {
    expect(contextModeForQuery("Его могу проходить в отпуске?")).toBe("none");
    expect(contextModeForQuery("Какие ответы я предпочитаю?")).toBe("relevant");
    expect(contextModeForQuery("Что я решил про новый зал?")).toBe("deep");
    expect(contextModeForQuery("Какие у меня задачи и напоминания на сегодня?")).toBe("operational");
  });

  it("filters weak, duplicate, current-thread and current-query memories", async () => {
    const current = database.recordMemoryEvent({
      owner: "1", namespace: "project", project: "/work/trainer", role: "user", kind: "message",
      body: "Текущий чат не должен вернуться в промпт", source: scopedMemorySource("telegram-text", "thread-1"),
    });
    const duplicate = database.recordMemoryEvent({
      owner: "1", namespace: "project", project: "/work/trainer", role: "user", kind: "voice",
      body: "Мне понравился светлый зал с большими окнами", source: scopedMemorySource("telegram-voice", "thread-2"),
    });
    const distinct = database.recordMemoryEvent({
      owner: "1", namespace: "project", project: "/work/trainer", role: "user", kind: "message",
      body: "Я решил посмотреть ещё несколько залов после отпуска", source: scopedMemorySource("telegram-text", "thread-3"),
    });
    const weak = database.recordMemoryEvent({
      owner: "1", namespace: "project", project: "/work/trainer", role: "user", kind: "document",
      body: "Старый нерелевантный черновик про ролики", source: "apple-notes:test",
    });
    const queryCopy = database.recordMemoryEvent({
      owner: "1", namespace: "project", project: "/work/trainer", role: "user", kind: "message",
      body: "Помощник, что я решил про новый зал?", source: scopedMemorySource("telegram-text", "thread-4"),
    });
    const scores = new Map([
      [current.id, 0.99], [duplicate.id, 0.91], [distinct.id, 0.87], [weak.id, 0.2], [queryCopy.id, 0.98],
    ]);
    const runCommand = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] !== "search") return "";
      return JSON.stringify([...scores].map(([id, score]) => ({ source: `/tmp/${id}.md`, score })));
    });
    const knowledge = {
      capture: vi.fn(),
      remove: vi.fn(),
      recall: vi.fn(async () => [{
        id: "observation-1",
        text: "Мне понравился светлый зал с большими окнами",
        type: "observation",
        score: 0.96,
      }]),
      reflect: vi.fn(async () => undefined),
      status: vi.fn(() => "Hindsight: готов"),
    };
    const service = new MemoryService(folder, "memsearch", database, runCommand, knowledge);
    const query = "Что я решил про новый зал?";

    const prompt = await service.augmentPrompt("1", query, "/work/trainer", { threadId: "thread-1" });
    const context = prompt.split("\n\nТекущий запрос:")[0];

    expect(prompt).not.toContain(current.body);
    expect(prompt).not.toContain(weak.body);
    expect(prompt).not.toContain(queryCopy.body);
    expect(prompt.split(duplicate.body)).toHaveLength(2);
    expect(prompt).toContain(distinct.body);
    expect(context.length).toBeLessThanOrEqual(3_500);
    expect(prompt).not.toContain("# ABOUT");
    expect(prompt).not.toContain("# NOW");
  });

  it("keeps automatic memory inside the task boundary and opens cross-task history only for deep recall", async () => {
    const current = database.recordMemoryEvent({
      owner: "1", namespace: "project", project: "/work/trainer", role: "user", kind: "message",
      body: "Текущая задача про условия работы", source: scopedMemorySource("telegram-text", "thread-current"),
    });
    const other = database.recordMemoryEvent({
      owner: "1", namespace: "project", project: "/work/trainer", role: "user", kind: "message",
      body: "В другой задаче я выбрал светлый зал", source: scopedMemorySource("telegram-text", "thread-other"),
    });
    const legacy = database.recordMemoryEvent({
      owner: "1", namespace: "project", project: "/work/trainer", role: "user", kind: "message",
      body: "Старый разговор Codex про окна", source: "telegram-text",
    });
    const archive = database.recordMemoryEvent({
      owner: "1", namespace: "project", project: "/work/trainer", role: "user", kind: "document",
      body: "В архиве я писал, что предпочитаю светлые залы", source: "telegram-export:archive",
    });
    const service = new MemoryService(folder, "memsearch", database, async (_executable, args) => {
      if (args[0] !== "search") return "";
      return JSON.stringify([current, other, legacy, archive].map((event, index) => ({
        source: `/tmp/${event.id}.md`, score: 0.95 - index * 0.01, content: event.body,
      })));
    });

    const relevant = await service.augmentPrompt(
      "1", "Какие условия я предпочитаю?", "/work/trainer", { mode: "relevant", threadId: "thread-current" },
    );
    const deep = await service.augmentPrompt(
      "1", "Что я решил раньше про условия?", "/work/trainer", { mode: "deep", threadId: "thread-current" },
    );

    expect(relevant).toContain(archive.body);
    expect(relevant).not.toContain(current.body);
    expect(relevant).not.toContain(other.body);
    expect(relevant).not.toContain(legacy.body);
    expect(deep).not.toContain(current.body);
    expect(deep).toContain(other.body);
    expect(deep).toContain(legacy.body);
  });

  it("injects NOW without the personal profile for operational questions", async () => {
    const service = new MemoryService(folder, "memsearch", database, async () => "[]");
    database.upsertPersonalFact({
      id: "identity:name", owner: "1", category: "identity", statement: "Имя — Валентин",
      subject: "Валентин", predicate: "name", object: "Валентин", status: "current", confidence: 1,
      observedAt: Date.parse("2026-08-09T00:00:00Z"), source: "user-confirmed:test",
    });
    database.createTask({ owner: "1", title: "Проверить билеты" });

    const prompt = await service.augmentPrompt("1", "Какие у меня задачи на сегодня?");

    expect(prompt).toContain("Проверить билеты");
    expect(prompt).not.toContain("Имя — Валентин");
    expect(prompt).not.toContain("# ABOUT");
  });
});
