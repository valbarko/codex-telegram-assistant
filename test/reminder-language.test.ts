import { describe, expect, it } from "vitest";

import { understandAlarm } from "../src/reminder-language.js";

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
});
