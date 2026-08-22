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

  it("persists assistant jobs before execution and suppresses replayed Telegram updates", () => {
    const input = {
      owner: "1", context: "1:42", chatId: "1", messageThreadId: 42, sourceUpdateId: 900,
      body: "Сделай статью", prompt: "Подготовь пакет", fingerprint: "article", kind: "article_bank" as const,
      workspace: "/bank", maxAttempts: 3,
    };
    const first = database.enqueueAssistantJob(input);
    const replay = database.enqueueAssistantJob({ ...input, body: "Повтор из Telegram" });
    const sameOpenRequest = database.enqueueAssistantJob({ ...input, sourceUpdateId: 901 });

    expect(first).toMatchObject({ duplicate: false, job: { state: "queued", attempts: 0 } });
    expect(replay).toMatchObject({ duplicate: true, job: { id: first.job.id } });
    expect(sameOpenRequest).toMatchObject({ duplicate: true, job: { id: first.job.id } });

    const running = database.claimAssistantJob(first.job.createdAt + 1);
    expect(running).toMatchObject({ id: first.job.id, state: "running", attempts: 1 });
    database.touchAssistantJob(first.job.id, 12_345);
    expect(database.completeAssistantJob(first.job.id, "Готово")).toBe(true);
    expect(database.assistantJob(first.job.id)).toMatchObject({ state: "succeeded", result: "Готово", lastEventAt: 12_345 });
    expect(database.pendingAssistantJobNotifications()).toHaveLength(1);
    expect(database.markAssistantJobNotified(first.job.id)).toBe(true);
    expect(database.pendingAssistantJobNotifications()).toEqual([]);
  });

  it("recovers interrupted jobs and allows an explicit retry after a terminal failure", () => {
    const created = database.enqueueAssistantJob({
      owner: "1", context: "1", chatId: "1", body: "Проверка", prompt: "Проверка", fingerprint: "check",
      kind: "assistant", maxAttempts: 2,
    }).job;
    database.claimAssistantJob(created.createdAt + 1);
    expect(database.recoverAssistantJobs(created.createdAt + 2)).toEqual({ retried: 1, failed: 0 });
    const second = database.claimAssistantJob(created.createdAt + 3)!;
    expect(second).toMatchObject({ state: "running", attempts: 2 });
    expect(database.finishAssistantJob(second.id, "failed", "transport", "offline")).toBe(true);
    expect(database.retryAssistantJobManually(second.id, "1", "1")).toMatchObject({ state: "queued", attempts: 0 });
  });

  it("holds a new job until its Telegram acknowledgement is stored, then releases it", () => {
    const now = Date.now();
    const created = database.enqueueAssistantJob({
      owner: "1", context: "1", chatId: "1", body: "Проверка", prompt: "Проверка", fingerprint: "held",
      kind: "assistant", maxAttempts: 3, nextAttemptAt: now + 60_000,
    }).job;

    expect(database.claimAssistantJob(now)).toBeUndefined();
    database.updateAssistantJobProgressMessage(created.id, 42);
    expect(database.releaseAssistantJob(created.id)).toBe(true);
    expect(database.claimAssistantJob(Date.now())).toMatchObject({ id: created.id, progressMessageId: 42, state: "running" });
  });

  it("persists the voice-writing mode per Telegram context", () => {
    expect(database.voiceWritingSettings("1:42", "1")).toMatchObject({ mode: "transcript" });
    database.setVoiceWritingSettings({ context: "1:42", owner: "1", mode: "diary" });
    expect(database.voiceWritingSettings("1:42", "1")).toMatchObject({ mode: "diary" });
    database.setVoiceWritingSettings({ context: "1:42", owner: "1", mode: "story", storyTitle: "Город у моря" });
    expect(database.voiceWritingSettings("1:42", "1")).toMatchObject({ mode: "story", storyTitle: "Город у моря" });
    expect(() => database.setVoiceWritingSettings({ context: "1:42", owner: "1", mode: "story" })).toThrow("Story title");
  });

  it("stores scoped memory events and supports pause and soft deletion", () => {
    const global = database.recordMemoryEvent({ owner: "1", namespace: "global", role: "user", kind: "message", body: "Люблю короткие ответы" });
    database.recordMemoryEvent({ owner: "1", namespace: "project", project: "/work/trainer", role: "assistant", kind: "response", body: "Добавили отчёт" });
    expect(database.memoryStatus("1")).toMatchObject({ active: 2, global: 1, project: 1, deleted: 0, paused: false });
    expect(database.forgetMemoryEvent("1", global.id)?.deletedAt).toBeTypeOf("number");
    database.setMemoryPaused("1", true);
    expect(database.memoryStatus("1")).toMatchObject({ active: 1, deleted: 1, paused: true });
  });

  it("updates an imported memory event by stable source without resurrecting forgotten content", () => {
    const first = database.upsertMemoryEventBySource({
      owner: "1", namespace: "global", role: "user", kind: "document",
      body: "Первая версия", source: "apple-notes:abc", createdAt: 100,
    });
    const unchanged = database.upsertMemoryEventBySource({
      owner: "1", namespace: "global", role: "user", kind: "document",
      body: "Первая версия", source: "apple-notes:abc", createdAt: 100,
    });
    const updated = database.upsertMemoryEventBySource({
      owner: "1", namespace: "global", role: "user", kind: "document",
      body: "Вторая версия", source: "apple-notes:abc", createdAt: 200,
    });

    expect(first.status).toBe("created");
    expect(unchanged.status).toBe("unchanged");
    expect(updated).toMatchObject({ status: "updated", event: { id: first.event.id, body: "Вторая версия", createdAt: 200 } });
    database.forgetMemoryEvent("1", first.event.id);
    expect(database.upsertMemoryEventBySource({
      owner: "1", namespace: "global", role: "user", kind: "document",
      body: "Третья версия", source: "apple-notes:abc", createdAt: 300,
    }).status).toBe("forgotten");
    expect(database.memoryEvents("1")).toEqual([]);
  });

  it("stores source-linked temporal facts for the canonical personal profile", () => {
    const first = database.upsertPersonalFact({
      id: "identity:name",
      owner: "1",
      category: "identity",
      statement: "Имя — Валентин",
      subject: "Валентин",
      predicate: "has_name",
      object: "Валентин",
      status: "current",
      confidence: 1,
      source: "telegram-export:test",
      evidenceMemoryId: "memory-1",
      validFrom: Date.parse("2023-07-07T00:00:00Z"),
      observedAt: Date.parse("2026-07-29T00:00:00Z"),
    });
    const { createdAt: _createdAt, changedAt: _changedAt, ...input } = first;
    const updated = database.upsertPersonalFact({
      ...input,
      statement: "Имя владельца — Валентин",
      confidence: 0.95,
    });

    expect(updated).toMatchObject({
      id: "identity:name",
      statement: "Имя владельца — Валентин",
      confidence: 0.95,
      evidenceMemoryId: "memory-1",
    });
    expect(updated.createdAt).toBe(first.createdAt);
    expect(database.personalFacts("1")).toHaveLength(1);
    const { createdAt: _updatedCreatedAt, changedAt: _updatedChangedAt, ...otherOwner } = updated;
    expect(() => database.upsertPersonalFact({ ...otherOwner, owner: "2" })).toThrow("another owner");
  });

  it("finds voice transcripts and generated daily summaries that must not remain in memory", () => {
    database.recordMemoryEvent({ owner: "1", namespace: "global", role: "user", kind: "voice", body: "Моя речь", source: "telegram-voice" });
    database.recordMemoryEvent({ owner: "1", namespace: "global", role: "user", kind: "voice", body: "Чужая речь", source: "telegram-forwarded-voice:Анна" });
    database.recordMemoryEvent({ owner: "1", namespace: "global", role: "user", kind: "voice", body: "Старая собственная речь", source: "telegram-voice:Валентин" });
    database.recordMemoryEvent({ owner: "1", namespace: "global", role: "assistant", kind: "response", body: "Ошибочная сводка", source: "daily-summary" });
    database.recordMemoryEvent({ owner: "1", namespace: "global", role: "user", kind: "message", body: "Рабочая задача", source: "telegram-text" });

    expect(database.reportExcludedMemoryEvents().map((event) => event.source)).toEqual(["telegram-forwarded-voice:Анна", "daily-summary"]);
  });

  it("finds task activity in a bounded day and aligns daily digests to fixed times", () => {
    const since = Date.now() - 1_000;
    const task = database.createTask({ owner: "1", title: "Подготовить отчёт" });
    database.updateTask(task.id, { status: "done", finishedAt: Date.now() });
    expect(database.tasksChangedSince("1", since).map((item) => item.id)).toContain(task.id);
    expect(database.tasksChangedBetween("1", since, Date.now() + 1_000).map((item) => item.id)).toContain(task.id);

    database.createAlarm({ owner: "1", label: "Вечерний дайджест", nextAt: 10_000, cadence: "daily", mode: "digest-evening" });
    database.createAlarm({ owner: "1", label: "Утро", nextAt: 11_000, cadence: "daily", mode: "digest-morning" });
    expect(database.alignDailyDigests(6_000, 6_000, 1_000)).toBe(2);
    expect(database.alarms("1").map((alarm) => [alarm.label, alarm.nextAt])).toEqual([
      ["Итог за вчера", 6_000], ["Утренний дайджест", 6_000],
    ]);
  });

  it("keeps a fixed daily wall-clock time after a delayed delivery", () => {
    const scheduled = Date.parse("2026-07-15T06:00:00+03:00");
    const alarm = database.createAlarm({ owner: "1", label: "Итог за вчера", nextAt: scheduled, cadence: "daily", mode: "digest-evening" });

    database.advanceAlarm(alarm.id, Date.parse("2026-07-15T06:33:36+03:00"));

    expect(database.alarms("1")[0]?.nextAt).toBe(Date.parse("2026-07-16T06:00:00+03:00"));
  });

  it("remembers sent blog-topic sources so they are not repeated within the history window", () => {
    database.recordBlogTopic({
      owner: "1", sourceId: "111", pillar: "training", studyTitle: "First", sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/111/",
      markdown: "Первая тема", sentAt: 100,
    });
    database.recordBlogTopic({
      owner: "1", sourceId: "222", pillar: "nutrition", studyTitle: "Second", sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/222/",
      markdown: "Вторая тема", sentAt: 200,
    });

    expect(database.sentBlogTopicSourceIds("1", 150)).toEqual(["222"]);
    expect(database.sentBlogTopicSourceIds("1", 0)).toEqual(["222", "111"]);
  });

  it("stores the selected morning blog topic", () => {
    database.recordBlogTopic({
      owner: "1", sourceId: "telegram:-100:7", pillar: "content-radar", studyTitle: "Ритм белка",
      sourceUrl: "https://t.me/source/7", markdown: "Карточка", sentAt: 100,
    });

    expect(database.selectBlogTopic("1", "telegram:-100:7", 200)).toMatchObject({
      studyTitle: "Ритм белка", selectedAt: 200,
    });
    expect(database.selectedBlogTopic("1")).toMatchObject({
      sourceId: "telegram:-100:7", selectedAt: 200,
    });
    expect(() => database.selectBlogTopic("1", "missing", 300)).toThrow(/not found/u);
  });
});
