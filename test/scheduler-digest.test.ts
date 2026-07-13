import { describe, expect, it } from "vitest";

import { dailySummaryPrompt, dailyWorkWindow } from "../src/scheduler.js";
import type { MemoryEvent, WorkItem } from "../src/storage.js";

describe("dailySummaryPrompt", () => {
  it("combines activity from all projects into one grounded summary request", () => {
    const task: WorkItem = {
      id: "task-1", owner: "1", title: "Недельный отчёт", prompt: "Собрать отчёт", status: "done",
      project: "/work/trainer", createdAt: 100, changedAt: 200, finishedAt: 200,
    };
    const event: MemoryEvent = {
      id: "memory-1", owner: "1", namespace: "global", role: "user", kind: "message",
      body: "Обсудили план запуска продукта", createdAt: 300,
    };
    const prompt = dailySummaryPrompt([task], [event], { trainer: "ТРЕНЕР" });

    expect(prompt).toContain("по всем проектам");
    expect(prompt).toContain("[ТРЕНЕР] Недельный отчёт");
    expect(prompt).toContain("[ОБЩЕЕ] user: Обсудили план запуска продукта");
    expect(prompt).toContain("ничего не выдумывай");
  });

  it("calculates the work window from user prompts, voice messages and commands", () => {
    const events: MemoryEvent[] = [
      { id: "assistant", owner: "1", namespace: "global", role: "assistant", kind: "response", body: "Ответ", createdAt: Date.parse("2026-07-12T06:00:00Z") },
      { id: "first", owner: "1", namespace: "global", role: "user", kind: "message", body: "Первый промпт", source: "telegram-text", createdAt: Date.parse("2026-07-12T07:15:00Z") },
      { id: "second", owner: "1", namespace: "global", role: "user", kind: "voice", body: "Продолжение", source: "telegram-voice", createdAt: Date.parse("2026-07-12T08:00:00Z") },
      { id: "internal", owner: "1", namespace: "global", role: "action", kind: "action", body: "Фоновый запуск", source: "scheduler", createdAt: Date.parse("2026-07-12T18:00:00Z") },
      { id: "last", owner: "1", namespace: "global", role: "action", kind: "action", body: "календарь Концерт", source: "telegram-text", createdAt: Date.parse("2026-07-12T17:50:00Z") },
    ];

    expect(dailyWorkWindow(events)).toBe([
      "🕒 Рабочее окно: 10:15–20:50 · 10 ч 35 мин · обращений: 3",
      "⚡ Расчётное чистое время: 45 мин · простои: 9 ч 50 мин (1, более 60 мин)",
    ].join("\n"));
  });

  it("keeps the full work window when there are no breaks longer than an hour", () => {
    const events: MemoryEvent[] = [
      { id: "first", owner: "1", namespace: "global", role: "user", kind: "message", body: "Начало", createdAt: Date.parse("2026-07-12T07:00:00Z") },
      { id: "middle", owner: "1", namespace: "global", role: "user", kind: "message", body: "Продолжение", createdAt: Date.parse("2026-07-12T07:45:00Z") },
      { id: "last", owner: "1", namespace: "global", role: "user", kind: "message", body: "Финал", createdAt: Date.parse("2026-07-12T08:30:00Z") },
    ];

    expect(dailyWorkWindow(events)).toContain("⚡ Расчётное чистое время: 1 ч 30 мин · простоев более 60 мин нет");
  });

  it("shows only the start time for one user interaction", () => {
    const events: MemoryEvent[] = [
      { id: "only", owner: "1", namespace: "global", role: "user", kind: "voice", body: "Одна запись", source: "telegram-voice", createdAt: Date.parse("2026-07-12T08:05:00Z") },
    ];

    expect(dailyWorkWindow(events)).toBe("🕒 Рабочее окно: старт в 11:05 · обращений: 1");
  });
});
