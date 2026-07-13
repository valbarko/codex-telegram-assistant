import type { Alarm } from "./storage.js";

export interface ParsedAlarm {
  label: string;
  at: number;
  cadence: Alarm["cadence"];
}

export function parseTemporalCodexResponse(value: string, now = new Date()): ParsedAlarm | null {
  const start = value.indexOf("{"); const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const data = parsed as Record<string, unknown>;
  const title = typeof data.title === "string" ? data.title.trim().replace(/\s+/g, " ") : "";
  const dateTime = typeof data.dateTime === "string" ? data.dateTime.trim() : "";
  const cadence = typeof data.cadence === "string" ? data.cadence : "once";
  if (!title || title.length > 200 || !/(?:Z|[+-]\d{2}:\d{2})$/.test(dateTime)) return null;
  if (!(["once", "daily", "weekdays", "weekly"] as const).includes(cadence as Alarm["cadence"])) return null;
  const at = Date.parse(dateTime);
  if (!Number.isFinite(at) || at <= now.getTime() || at > now.getTime() + 5 * 366 * 86_400_000) return null;
  return { label: title, at, cadence: cadence as Alarm["cadence"] };
}

export function normalizeCalendarTitle(label: string): string {
  const title = label.trim().replace(/\s+/g, " ");
  return /^[а-яё]/u.test(title) ? `${title[0]!.toLocaleUpperCase("ru-RU")}${title.slice(1)}` : title;
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
  const tomorrow = input.match(/(?:^|\s)завтра\s*[,;]?\s*(?:(?:в|на)\s*)?(\d{1,2})?(?::(\d{2}))?/i);
  if (tomorrow) {
    const date = new Date(now); date.setDate(date.getDate() + 1); date.setHours(Number(tomorrow[1] ?? 9), Number(tomorrow[2] ?? 0), 0, 0);
    return result(input, tomorrow[0], date.getTime(), "once");
  }
  const today = input.match(/(?:^|\s)сегодня\s*[,;]?\s*(?:(?:в|на)\s*)?(\d{1,2})(?::(\d{2}))?/i);
  if (today) {
    const date = new Date(now); date.setHours(Number(today[1]), Number(today[2] ?? 0), 0, 0);
    return date.getTime() > now.getTime() ? result(input, today[0], date.getTime(), "once") : null;
  }
  const weekdayName = "(воскресень(?:е|я)|понедельник|вторник|сред(?:а|у)|четверг|пятниц(?:а|у)|суббот(?:а|у))";
  const weekdayFirst = input.match(new RegExp(`(?:^|\\s)(?:в\\s+)?${weekdayName}\\s*[,;]?\\s*(?:(?:в|на)\\s*)?(\\d{1,2})(?::(\\d{2}))?`, "i"));
  if (weekdayFirst) {
    const weekday = weekdayNumber(weekdayFirst[1]!);
    const hour = Number(weekdayFirst[2]); const minute = Number(weekdayFirst[3] ?? 0);
    if (weekday !== undefined && validClock(hour, minute)) return result(input, weekdayFirst[0], nextWeekday(now, weekday, hour, minute), "once");
  }
  const timeFirst = input.match(new RegExp(`(?:^|\\s)(?:(?:в|на)\\s*)?(\\d{1,2})(?::(\\d{2}))?\\s*[,;]?\\s*(?:в\\s+)?${weekdayName}(?=\\s|$)`, "i"));
  if (timeFirst) {
    const hour = Number(timeFirst[1]); const minute = Number(timeFirst[2] ?? 0);
    const weekday = weekdayNumber(timeFirst[3]!);
    if (weekday !== undefined && validClock(hour, minute)) return result(input, timeFirst[0], nextWeekday(now, weekday, hour, minute), "once");
  }
  const explicit = input.match(/(?:^|\s)(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?(?:\s+(?:в\s*)?(\d{1,2})(?::(\d{2}))?)?/);
  if (explicit) {
    let year = Number(explicit[3] ?? now.getFullYear()); if (year < 100) year += 2000;
    const date = new Date(year, Number(explicit[2]) - 1, Number(explicit[1]), Number(explicit[4] ?? 9), Number(explicit[5] ?? 0));
    return date.getTime() > now.getTime() ? result(input, explicit[0], date.getTime(), "once") : null;
  }
  const clock = input.match(/(?:^|\s)(?:в|на)\s*(\d{1,2})(?::(\d{2}))?(?=\s|$|[,.!?])/i);
  if (clock) return result(input, clock[0], nextClock(now, Number(clock[1]), Number(clock[2] ?? 0)), "once");
  return null;
}

function result(input: string, matched: string, at: number, cadence: Alarm["cadence"]): ParsedAlarm {
  const label = input
    .replace(/^\s*(?:(?:создай|добавь|запланируй|поставь)\s+(?:(?:задачу|событие|встречу)\s+)?(?:в\s+)?календар(?:ь|е)(?:\s+на)?|напомни(?:\s+мне)?|создай\s+напоминание|поставь\s+будильник|установи\s+будильник|создай\s+событие|добавь\s+событие|запланируй\s+(?:событие|встречу))\s*/i, "")
    .replace(matched.trim(), "").replace(/^\s*[|,.:;-]?\s*|\s*[|,.:;-]?\s*$/g, "");
  return { label: label || "Напоминание", at, cadence };
}

function nextClock(now: Date, hour: number, minute: number): number {
  const date = new Date(now); date.setHours(hour, minute, 0, 0); if (date <= now) date.setDate(date.getDate() + 1); return date.getTime();
}
function nextWeekday(now: Date, weekday: number, hour: number, minute: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + ((weekday - date.getDay() + 7) % 7));
  date.setHours(hour, minute, 0, 0);
  if (date <= now) date.setDate(date.getDate() + 7);
  return date.getTime();
}
function weekdayNumber(value: string): number | undefined {
  const word = value.toLocaleLowerCase("ru-RU");
  if (word.startsWith("воскрес")) return 0;
  if (word.startsWith("понедель")) return 1;
  if (word.startsWith("вторник")) return 2;
  if (word.startsWith("сред")) return 3;
  if (word.startsWith("четверг")) return 4;
  if (word.startsWith("пятниц")) return 5;
  if (word.startsWith("суббот")) return 6;
  return undefined;
}
function validClock(hour: number, minute: number): boolean { return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59; }
function plusDays(value: number, days: number): number { const date = new Date(value); date.setDate(date.getDate() + days); return date.getTime(); }
