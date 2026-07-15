import { describe, expect, it } from "vitest";

import { parseEventKitCalendar, shortcutDateInput } from "../src/mac-bridge.js";

describe("system alarm shortcut input", () => {
  it("passes an unambiguous local date and time to Shortcuts", () => {
    const value = new Date("2026-07-12T14:00:00+03:00").getTime();
    expect(shortcutDateInput(value)).toBe("2026-07-12 14:00:00");
  });
});

describe("Apple Calendar EventKit output", () => {
  it("formats timed and all-day events in Moscow time", () => {
    const rows = parseEventKitCalendar(JSON.stringify([
      { title: "Тренировка", start: Date.parse("2026-07-15T10:00:00+03:00"), allDay: false, calendar: "Работа" },
      { title: "День рождения", start: Date.parse("2026-07-15T00:00:00+03:00"), allDay: true, calendar: "Дни рождения" },
    ]), false);

    expect(rows).toEqual([
      { title: "День рождения", start: "Весь день", calendar: "Дни рождения", startOrder: Date.parse("2026-07-15T00:00:00+03:00") },
      { title: "Тренировка", start: "10:00", calendar: "Работа", startOrder: Date.parse("2026-07-15T10:00:00+03:00") },
    ]);
  });

  it("includes the date in the seven-day view", () => {
    const rows = parseEventKitCalendar(JSON.stringify([
      { title: "Встреча", start: Date.parse("2026-07-16T19:00:00+03:00"), allDay: false, calendar: "Работа" },
    ]), true);

    expect(rows[0]?.start).toBe("16 июля, 19:00");
  });
});
