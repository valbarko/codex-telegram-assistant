import { describe, expect, it } from "vitest";

import { dailyActivitySummary, dailyCompletionEvidence, dailyDigestPolishPrompt, dailyReport, dailySummaryPrompt, localDailyDigest,
  morningDigestText, parseWorkJournal, previousDayWindow, recentProjectThreads, type WorkJournalEntry } from "../src/scheduler.js";
import type { StoredThread } from "../src/codex-engine.js";
import type { MemoryEvent, WorkItem } from "../src/storage.js";
import type { UnifiedWorkGroup } from "../src/work-dashboard.js";

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
    expect(prompt).toContain("расшифровываемых");
    expect(prompt).toContain("Не оценивай рабочее время");
  });

  it("selects the previous calendar day for a 06:00 report", () => {
    expect(previousDayWindow(Date.parse("2026-07-14T06:00:00+03:00"))).toEqual({
      since: Date.parse("2026-07-13T00:00:00+03:00"),
      until: Date.parse("2026-07-14T00:00:00+03:00"),
    });
  });

  it("asks Codex to edit the dry digest without changing its facts", () => {
    const prompt = dailyDigestPolishPrompt("**Главное**\n\nПроектов: **3**", "ПРОЕКТ ТРЕНЕР\n- подтверждённый результат: исправлено");

    expect(prompt).toContain("Сохрани все проверенные факты, цифры, времена, проекты");
    expect(prompt).toContain("сформируй честный раздел **Что завершили**");
    expect(prompt).toContain("SHA, PR, GitHub-ссылки");
    expect(prompt).toContain("Проектов: **3**");
    expect(prompt).toContain("ПРОЕКТ ТРЕНЕР");
  });

  it("collects verified journal completions beyond tasks stored by the bot", () => {
    const task: WorkItem = {
      id: "task-1", owner: "1", title: "Убрать кнопки", prompt: "Убрать кнопки", status: "done",
      project: "/work/helper", createdAt: 1, changedAt: 2,
    };
    const journal: WorkJournalEntry[] = [
      { project: "/work/trainer", time: "10:00", request: "исправь запуск", result: "Исправлено на production. PR #12, SHA abcdef1234567890, https://github.com/example/repo" },
      { project: "/work/trainer", time: "11:00", request: "сделай ревью", result: "Нашёл два замечания, правки ещё не внесены." },
    ];

    const evidence = dailyCompletionEvidence([task], journal, { helper: "ПОМОЩНИК", trainer: "ТРЕНЕР" });

    expect(evidence).toContain("ПРОЕКТ ТРЕНЕР");
    expect(evidence).toContain("исправь запуск");
    expect(evidence).toContain("отдельная задача бота со статусом done: Убрать кнопки");
    expect(evidence).not.toContain("сделай ревью");
    expect(evidence).not.toMatch(/https?:\/\/|github\.com|abcdef1234567890|PR #12/);
  });

  it("keeps several independent closures while merging duplicate sub-results", () => {
    const journal: WorkJournalEntry[] = [
      { project: "/work/trainer", time: "10:00", request: "Ошибка в тренировке", result: "Исправлено на production: функция ломала запуск тренировок." },
      { project: "/work/trainer", time: "11:00", request: "перегенерируй", result: "Готово: 20 постеров перегенерированы по комментариям." },
      { project: "/work/trainer", time: "12:00", request: "отлично", result: "Готово — вся генерация завершена; покрыто 335 из 335 упражнений." },
      { project: "/work/trainer", time: "13:00", request: "да", result: "Готово. База полностью обновлена свежим snapshot с прода." },
      { project: "/work/trainer", time: "14:00", request: "Files mentioned by the user", result: "Готово в ветке codex/local-only." },
    ];

    const text = localDailyDigest([], [], { trainer: "ТРЕНЕР" }, journal);

    expect(text).toContain("исправлена ошибка запуска тренировки на проде");
    expect(text).toContain("завершена генерация постеров для всей библиотеки упражнений");
    expect(text).toContain("рабочая копия данных обновлена с продакшена");
    expect(text).not.toContain("20 постеров перегенерированы");
    expect(text).not.toContain("local-only");
  });

  it("extracts actual requests and results from a project work journal", () => {
    const journal = [
      "### 08:10", "- User asked: исправь отчёт", "- Codex: Исправлено локально.", "", "### 09:20",
      "- User asked: закрой", "- Codex: PR смержен, production проверен.",
    ].join("\n");

    expect(parseWorkJournal(journal, "/work/trainer")).toEqual([
      { project: "/work/trainer", time: "08:10", request: "исправь отчёт", result: "Исправлено локально." },
      { project: "/work/trainer", time: "09:20", request: "закрой", result: "PR смержен, production проверен." },
    ]);
  });

  it("builds the morning plan from weather, calendar and every active project", () => {
    const groups: UnifiedWorkGroup[] = [
      { label: "ТРЕНЕР", items: [{ id: "a", kind: "thread", title: "Проверить отчёты", status: "running", project: "/work/trainer", projectLabel: "ТРЕНЕР", updatedAt: 3 }] },
      { label: "КЛИЕНТЫ", items: [{ id: "b", kind: "task", title: "Ответить Анне", status: "waiting", project: "/work/clients", projectLabel: "КЛИЕНТЫ", updatedAt: 4 }] },
    ];
    const text = morningDigestText({
      weather: "🌦 Погода · Москва\nясно · +18…+27 °C",
      calendar: [{ title: "Тренировка", start: "15 июля 10:00", calendar: "Работа" }],
      groups, inbox: 2, tasks: [], now: Date.parse("2026-07-15T09:00:00+03:00"),
    });

    expect(text).toContain("Погода · Москва");
    expect(text).toContain("**+18…+27 °C**");
    expect(text).toContain("Тренировка");
    expect(text).toContain("Активно: **2 темы** в **2 проектах**");
    expect(text).toContain("❓ **Нужен ответ · КЛИЕНТЫ** — Ответить Анне");
    expect(text).toContain("**ТРЕНЕР · 1** — отчёты.");
    expect(text).toContain("**КЛИЕНТЫ · 1** — ответить Анне.");
    expect(text).not.toContain("3 главных приоритета");
  });

  it("shows only evidence-backed urgent work instead of recent threads as priorities", () => {
    const now = Date.parse("2026-07-15T09:00:00+03:00");
    const groups: UnifiedWorkGroup[] = [{ label: "КЛИЕНТЫ", items: [
      { id: "overdue", kind: "task", title: "Ответить Анне", status: "todo", project: "/work/clients", projectLabel: "КЛИЕНТЫ", updatedAt: 3 },
      { id: "waiting", kind: "thread", title: "Согласовать макет", status: "waiting", project: "/work/clients", projectLabel: "КЛИЕНТЫ", updatedAt: 4 },
      { id: "recent", kind: "thread", title: "Недавняя тема", status: "running", project: "/work/clients", projectLabel: "КЛИЕНТЫ", updatedAt: 5 },
    ] }];
    const tasks: WorkItem[] = [{
      id: "overdue", owner: "1", title: "Ответить Анне", prompt: "Ответить Анне", status: "todo",
      project: "/work/clients", dueAt: Date.parse("2026-07-14T10:00:00+03:00"), createdAt: 1, changedAt: 3,
    }];

    const text = morningDigestText({ weather: "🌦 Погода · Москва\nясно · +20 °C", calendar: [], groups, inbox: 0, tasks, now });

    expect(text).toContain("Требуют внимания: **2**");
    expect(text).toContain("🔴 **Просрочено · КЛИЕНТЫ** — Ответить Анне");
    expect(text).toContain("❓ **Нужен ответ · КЛИЕНТЫ** — Согласовать макет");
    const important = text.split("**Самое важное**")[1]?.split("**Проекты**")[0] ?? "";
    expect(important).not.toContain("Недавняя тема");
  });

  it("keeps all project journals, normalizes aliases and reports the activity period honestly", () => {
    const task: WorkItem = {
      id: "task-1", owner: "1", title: "Давай уберем нижние кнопки из бота. Оставим только бургер с меню.", prompt: "Убрать кнопки", status: "done",
      project: "/work/helper", projectLabel: "helper", createdAt: 1, changedAt: 2,
    };
    const journal: WorkJournalEntry[] = [
      { project: "/work/helper", time: "06:10", request: "попробуй сейчас", result: "Готово. Черновик vc.ru (https://vc.ru/example) сохранён." },
      { project: "/work/trainer", time: "22:40", request: "проверь программу", result: "PR #370 merged: https://github.com/example/repo; SHA abcdef1234567890." },
    ];

    const text = localDailyDigest([task], [], { helper: "ПОМОЩНИК", trainer: "ТРЕНЕР" }, journal);

    expect(text).toContain("Проектов с активностью: **2**");
    expect(text).toContain("Проектов с подтверждёнными завершениями: **2**");
    expect(text).not.toContain("Закрыто задач: **1**");
    expect(text).toContain("**06:10–22:40**");
    expect(text).toContain("Для оценки активного времени недостаточно обращений.");
    expect(text).toContain("*Оценка: перерывы без обращений дольше 60 минут вычтены; короткие паузы считаются рабочими.*");
    expect(text).toContain("**ПОМОЩНИК** · **1 обращение** · 06:10\nЧерновик vc.ru сохранён.");
    expect(text).toContain("**ТРЕНЕР** · **1 обращение** · 22:40\nПроверка программы.");
    expect(text).not.toMatch(/https?:\/\/|github\.com|abcdef1234567890|PR #370/);
    expect(text).not.toContain("запрос");
    expect(text).toContain("**Что завершили**");
    expect(text).toContain("убрали нижние кнопки из бота, оставили только бургер-меню");
    expect(text).toContain("**ТРЕНЕР:** проверка программы.");
    expect(dailyReport(text, Date.parse("2026-07-14T00:00:00+03:00"))).toContain("🌅 **Итог за 14 июля**");
  });

  it("subtracts breaks longer than 60 minutes from the activity estimate", () => {
    const times = ["04:47", "05:00", "05:20", "05:40", "06:00", "06:20", "06:40", "07:00", "07:20", "07:40", "09:00"];
    const journal = times.map((time): WorkJournalEntry => ({
      project: "/work/helper", time, request: `запрос ${time}`, result: "готово",
    }));

    const text = dailyActivitySummary([], journal, { helper: "ПОМОЩНИК" });

    expect(text).toContain("**04:47–09:00** · период **4 ч 13 мин**");
    expect(text).toContain("Оценочно активно: **2 ч 53 мин**");
    expect(text).toContain("Перерывы дольше часа: **1** · всего **1 ч 20 мин**");
    expect(text).toContain("**07:40–09:00** · 1 ч 20 мин");
  });

  it("keeps only recent Codex threads and caps each project in the morning plan", () => {
    const now = Date.parse("2026-07-15T09:00:00+03:00");
    const thread = (id: string, workspace: string, updatedAt: number): StoredThread => ({
      id, workspace, updatedAt, title: id, archived: false,
    });
    const rows = recentProjectThreads([
      thread("old", "/work/helper", Date.parse("2026-07-13T23:59:00+03:00")),
      thread("a", "/work/helper", now - 1), thread("b", "/work/helper", now - 2),
      thread("c", "/work/helper", now - 3), thread("capped", "/work/helper/", now - 4),
      thread("client", "/work/clients", now - 5),
    ], now);

    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c", "client"]);
  });
});
