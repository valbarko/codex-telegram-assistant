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

  it("finds voice transcripts and generated daily summaries that must not remain in memory", () => {
    database.recordMemoryEvent({ owner: "1", namespace: "global", role: "user", kind: "voice", body: "Чужая речь", source: "telegram-voice:Анна" });
    database.recordMemoryEvent({ owner: "1", namespace: "global", role: "assistant", kind: "response", body: "Ошибочная сводка", source: "daily-summary" });
    database.recordMemoryEvent({ owner: "1", namespace: "global", role: "user", kind: "message", body: "Рабочая задача", source: "telegram-text" });

    expect(database.reportExcludedMemoryEvents().map((event) => event.source)).toEqual(["telegram-voice:Анна", "daily-summary"]);
  });

  it("finds task activity in a bounded day and aligns daily digests to fixed times", () => {
    const since = Date.now() - 1_000;
    const task = database.createTask({ owner: "1", title: "Подготовить отчёт" });
    database.updateTask(task.id, { status: "done", finishedAt: Date.now() });
    expect(database.tasksChangedSince("1", since).map((item) => item.id)).toContain(task.id);
    expect(database.tasksChangedBetween("1", since, Date.now() + 1_000).map((item) => item.id)).toContain(task.id);

    database.createAlarm({ owner: "1", label: "Вечерний дайджест", nextAt: 10_000, cadence: "daily", mode: "digest-evening" });
    database.createAlarm({ owner: "1", label: "Утро", nextAt: 11_000, cadence: "daily", mode: "digest-morning" });
    expect(database.alignDailyDigests(6_000, 9_000, 1_000)).toBe(2);
    expect(database.alarms("1").map((alarm) => [alarm.label, alarm.nextAt])).toEqual([
      ["Итог за вчера", 6_000], ["Утренний дайджест", 9_000],
    ]);
  });

  it("keeps a fixed daily wall-clock time after a delayed delivery", () => {
    const scheduled = Date.parse("2026-07-15T06:00:00+03:00");
    const alarm = database.createAlarm({ owner: "1", label: "Итог за вчера", nextAt: scheduled, cadence: "daily", mode: "digest-evening" });

    database.advanceAlarm(alarm.id, Date.parse("2026-07-15T06:33:36+03:00"));

    expect(database.alarms("1")[0]?.nextAt).toBe(Date.parse("2026-07-16T06:00:00+03:00"));
  });
});
