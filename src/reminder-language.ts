import type { Alarm } from "./storage.js";

export interface ParsedAlarm {
  label: string;
  at: number;
  cadence: Alarm["cadence"];
}

export function understandAlarm(source: string, now = new Date()): ParsedAlarm | null {
  const input = source.trim().replace(/\s+/g, " ");
  if (!input) return null;
  const relative = input.match(/(?:^|\s)через\s+(\d+)\s*(минут(?:у|ы)?|час(?:а|ов)?|день|дн(?:я|ей))(?=\s|$)/i);
  if (relative) {
    const count = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const milliseconds = unit.startsWith("минут") ? 60_000 : unit.startsWith("час") ? 3_600_000 : 86_400_000;
    return result(input, relative[0], now.getTime() + count * milliseconds, "once");
  }
  const everyDay = input.match(/(?:^|\s)(?:каждый день|ежедневно)\s+(?:в\s*)?(\d{1,2})(?::(\d{2}))?/i);
  if (everyDay) return result(input, everyDay[0], nextClock(now, Number(everyDay[1]), Number(everyDay[2] ?? 0)), "daily");
  const workdays = input.match(/(?:^|\s)(?:по будням|каждый будний день)\s+(?:в\s*)?(\d{1,2})(?::(\d{2}))?/i);
  if (workdays) {
    let at = nextClock(now, Number(workdays[1]), Number(workdays[2] ?? 0));
    while ([0, 6].includes(new Date(at).getDay())) at = plusDays(at, 1);
    return result(input, workdays[0], at, "weekdays");
  }
  const tomorrow = input.match(/(?:^|\s)завтра(?:\s+в)?\s*(\d{1,2})?(?::(\d{2}))?/i);
  if (tomorrow) {
    const date = new Date(now); date.setDate(date.getDate() + 1); date.setHours(Number(tomorrow[1] ?? 9), Number(tomorrow[2] ?? 0), 0, 0);
    return result(input, tomorrow[0], date.getTime(), "once");
  }
  const today = input.match(/(?:^|\s)сегодня(?:\s+в)?\s*(\d{1,2})(?::(\d{2}))?/i);
  if (today) {
    const date = new Date(now); date.setHours(Number(today[1]), Number(today[2] ?? 0), 0, 0);
    return date.getTime() > now.getTime() ? result(input, today[0], date.getTime(), "once") : null;
  }
  const explicit = input.match(/(?:^|\s)(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?(?:\s+(?:в\s*)?(\d{1,2})(?::(\d{2}))?)?/);
  if (explicit) {
    let year = Number(explicit[3] ?? now.getFullYear()); if (year < 100) year += 2000;
    const date = new Date(year, Number(explicit[2]) - 1, Number(explicit[1]), Number(explicit[4] ?? 9), Number(explicit[5] ?? 0));
    return date.getTime() > now.getTime() ? result(input, explicit[0], date.getTime(), "once") : null;
  }
  return null;
}

function result(input: string, matched: string, at: number, cadence: Alarm["cadence"]): ParsedAlarm {
  const label = input.replace(/^\s*(?:напомни(?:\s+мне)?|создай напоминание)\s*/i, "").replace(matched.trim(), "").replace(/^\s*[|,.:;-]?\s*|\s*[|,.:;-]?\s*$/g, "");
  return { label: label || "Напоминание", at, cadence };
}

function nextClock(now: Date, hour: number, minute: number): number {
  const date = new Date(now); date.setHours(hour, minute, 0, 0); if (date <= now) date.setDate(date.getDate() + 1); return date.getTime();
}
function plusDays(value: number, days: number): number { const date = new Date(value); date.setDate(date.getDate() + days); return date.getTime(); }
