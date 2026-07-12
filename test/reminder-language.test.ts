import { describe, expect, it } from "vitest";

import { normalizeCalendarTitle, understandAlarm } from "../src/reminder-language.js";

describe("understandAlarm", () => {
  const now = new Date(2026, 6, 12, 10, 0, 0);
  it("understands relative Russian time", () => {
    expect(understandAlarm("напомни через 30 минут позвонить Анне", now)).toEqual({
      label: "позвонить Анне", at: now.getTime() + 30 * 60_000, cadence: "once",
    });
  });
  it("understands tomorrow and recurring workdays", () => {
    expect(understandAlarm("завтра в 14:30 договор", now)?.label).toBe("договор");
    expect(understandAlarm("по будням в 18 итоги", now)).toMatchObject({ label: "итоги", cadence: "weekdays" });
  });
  it("rejects an elapsed time", () => expect(understandAlarm("сегодня в 9 поздно", now)).toBeNull());
  it("understands a standalone alarm time", () => {
    expect(understandAlarm("поставь будильник на 14:00", now)).toEqual({
      label: "Напоминание", at: new Date(2026, 6, 12, 14, 0, 0).getTime(), cadence: "once",
    });
  });
  it("understands a comma between today and event time", () => {
    expect(understandAlarm("создай событие сегодня, 18:00 Позвонить клиенту", now)).toEqual({
      label: "Позвонить клиенту", at: new Date(2026, 6, 12, 18, 0, 0).getTime(), cadence: "once",
    });
  });
  it("removes the calendar command envelope from the event title", () => {
    const parsed = understandAlarm("создай задачу в календаре на сегодня 18:00 встреча", now);
    expect(parsed).toEqual({
      label: "встреча", at: new Date(2026, 6, 12, 18, 0, 0).getTime(), cadence: "once",
    });
    expect(normalizeCalendarTitle(parsed!.label)).toBe("Встреча");
  });
});
