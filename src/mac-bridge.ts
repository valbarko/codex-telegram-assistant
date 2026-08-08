import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const CALENDAR_READ_AUTHORIZATION_STATUSES = [3] as const;

export interface CalendarEntry { title: string; start: string; calendar: string; startOrder?: number; }

export interface AppleNoteAppend {
  folder: string;
  title: string;
  html: string;
  sectionMarker?: string;
  continuationHtml?: string;
}

export async function upcomingCalendar(days = 7, maximum = 12): Promise<CalendarEntry[]> {
  const from = Date.now();
  return eventKitCalendar(from, from + Math.max(1, days) * 24 * 60 * 60_000, maximum, true);
}

export async function todayCalendar(maximum = 12): Promise<CalendarEntry[]> {
  const fromDate = new Date();
  fromDate.setHours(0, 0, 0, 0);
  const untilDate = new Date(fromDate);
  untilDate.setDate(untilDate.getDate() + 1);
  return eventKitCalendar(fromDate.getTime(), untilDate.getTime(), maximum, false);
}

async function eventKitCalendar(from: number, until: number, maximum: number, includeDate: boolean): Promise<CalendarEntry[]> {
  const nativeContent = await nativeCalendar(from, until);
  if (nativeContent !== undefined) {
    return parseEventKitCalendar(nativeContent, includeDate).slice(0, Math.max(0, maximum));
  }
  const script = `ObjC.import('EventKit')
var authorization = Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent))
if (${JSON.stringify(CALENDAR_READ_AUTHORIZATION_STATUSES)}.indexOf(authorization) === -1) throw new Error('Apple Calendar full access is not granted (status ' + authorization + ')')
var store = $.EKEventStore.alloc.init
var calendars = store.calendarsForEntityType($.EKEntityTypeEvent)
if (Number(calendars.count) === 0) throw new Error('Apple Calendar has no readable calendars')
var fromDate = $.NSDate.dateWithTimeIntervalSince1970(${Math.floor(from / 1000)})
var untilDate = $.NSDate.dateWithTimeIntervalSince1970(${Math.ceil(until / 1000)})
var predicate = store.predicateForEventsWithStartDateEndDateCalendars(fromDate, untilDate, calendars)
var events = store.eventsMatchingPredicate(predicate)
var rows = []
for (var index = 0; index < Number(events.count); index++) {
  var event = events.objectAtIndex(index)
  rows.push({
    title: ObjC.unwrap(event.title) || '',
    start: Number(event.startDate.timeIntervalSince1970) * 1000,
    allDay: Boolean(event.allDay),
    calendar: ObjC.unwrap(event.calendar.title) || ''
  })
}
JSON.stringify(rows)`;
  const content = await javaScript(script, 8_000);
  return parseEventKitCalendar(content, includeDate).slice(0, Math.max(0, maximum));
}

interface NativeCalendarResult {
  ok?: unknown;
  events?: unknown;
  error?: unknown;
  authorizationStatus?: unknown;
}

async function nativeCalendar(from: number, until: number): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const application = await calendarReaderApplication();
  if (!application) return undefined;
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-calendar-reader-"));
  const output = path.join(directory, "result.json");
  try {
    await execute("/usr/bin/open", ["-W", "-n", application, "--args", "--output", output,
      "--from", String(from), "--until", String(until)], { timeout: 40_000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(await readFile(output, "utf8")) as NativeCalendarResult;
    if (parsed.ok !== true || !Array.isArray(parsed.events)) {
      const status = typeof parsed.authorizationStatus === "number" ? ` (status ${parsed.authorizationStatus})` : "";
      const reason = typeof parsed.error === "string" && parsed.error.trim() ? `: ${parsed.error.trim()}` : "";
      throw new Error(`Apple Calendar full access is not granted${status}${reason}`);
    }
    return JSON.stringify(parsed.events);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function calendarReaderApplication(): Promise<string | undefined> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDirectory, "CodexCalendarReader.app"),
    path.join(moduleDirectory, "..", "dist", "CodexCalendarReader.app"),
  ];
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "Contents", "MacOS", "CodexCalendarReader"));
      return candidate;
    } catch {}
  }
  return undefined;
}

export function calendarReadAccessGranted(status: number): boolean {
  return CALENDAR_READ_AUTHORIZATION_STATUSES.some((candidate) => candidate === status);
}

export function parseEventKitCalendar(content: string, includeDate: boolean): CalendarEntry[] {
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Apple Calendar returned invalid data");
  return parsed.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    const calendar = typeof row.calendar === "string" ? row.calendar.trim() : "";
    const startOrder = Number(row.start);
    if (!title || !calendar || !Number.isFinite(startOrder)) return [];
    return [{ title, calendar, startOrder, start: formatCalendarStart(startOrder, row.allDay === true, includeDate) }];
  }).sort((left, right) => (left.startOrder ?? Number.MAX_SAFE_INTEGER) - (right.startOrder ?? Number.MAX_SAFE_INTEGER));
}

function formatCalendarStart(value: number, allDay: boolean, includeDate: boolean): string {
  const date = new Date(value);
  const day = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" }).format(date);
  if (allDay) return includeDate ? `${day} · весь день` : "Весь день";
  const time = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(date);
  return includeDate ? `${day}, ${time}` : time;
}

export async function addCalendarEvent(title: string, start: number, minutes = 60): Promise<void> {
  const date = new Date(start);
  const script = `on run argv
set eventTitle to item 1 of argv
set eventDate to current date
set year of eventDate to (item 2 of argv as integer)
set month of eventDate to (item 3 of argv as integer)
set day of eventDate to (item 4 of argv as integer)
set hours of eventDate to (item 5 of argv as integer)
set minutes of eventDate to (item 6 of argv as integer)
set seconds of eventDate to 0
tell application "Calendar"
tell first calendar whose writable is true
make new event with properties {summary:eventTitle, start date:eventDate, end date:(eventDate + (item 7 of argv as integer))}
end tell
end tell
end run`;
  await appleScript(script, [title, String(date.getFullYear()), String(date.getMonth() + 1), String(date.getDate()), String(date.getHours()), String(date.getMinutes()), String(minutes * 60)]);
}

export async function makeMailDraft(address: string, subject: string, body: string): Promise<void> {
  const script = `on run argv
tell application "Mail"
set draft to make new outgoing message with properties {subject:(item 2 of argv), content:(item 3 of argv), visible:true}
tell draft to make new to recipient at end of to recipients with properties {address:(item 1 of argv)}
save draft
activate
end tell
end run`;
  await appleScript(script, [address, subject, body]);
}

export async function appendAppleNote(input: AppleNoteAppend): Promise<string> {
  const script = `on run argv
set folderName to item 1 of argv
set noteTitle to item 2 of argv
set fullHtml to item 3 of argv
set sectionMarker to item 4 of argv
set continuationHtml to item 5 of argv
tell application "Notes"
set targetAccount to first account
repeat with candidate in accounts
if (name of candidate as text) contains "iCloud" then
set targetAccount to candidate
exit repeat
end if
end repeat
try
set targetFolder to folder folderName of targetAccount
on error
set targetFolder to make new folder at targetAccount with properties {name:folderName}
end try
set matches to every note of targetFolder whose name is noteTitle
if (count of matches) is 0 then
make new note at targetFolder with properties {name:noteTitle, body:fullHtml}
else
set targetNote to item 1 of matches
set addition to fullHtml
if sectionMarker is not "" and (body of targetNote as text) contains sectionMarker then set addition to continuationHtml
set body of targetNote to ((body of targetNote as text) & "<br><br>" & addition)
end if
return name of targetAccount as text
end tell
end run`;
  return appleScript(script, [input.folder, input.title, input.html, input.sectionMarker ?? "", input.continuationHtml ?? input.html]);
}

export async function addAppleChecklistItem(text: string, shortcut = "Codex Рабочая задача"): Promise<void> {
  const value = text.trim();
  if (!value) throw new Error("Checklist item is required");
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-work-task-"));
  const input = path.join(directory, "task.txt");
  try {
    await writeFile(input, value, "utf8");
    try {
      await execute("/usr/bin/shortcuts", ["run", shortcut, "--input-path", input], {
        timeout: 12_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      if (await appleNoteContains("РАБОЧИЕ ЗАДАЧИ", value)) return;
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function appleNoteContains(title: string, text: string): Promise<boolean> {
  const script = `on run argv
set noteTitle to item 1 of argv
set needle to item 2 of argv
tell application "Notes"
repeat with candidateAccount in accounts
repeat with candidateFolder in folders of candidateAccount
set matches to every note of candidateFolder whose name is noteTitle
repeat with candidateNote in matches
if (body of candidateNote as text) contains needle then return "yes"
end repeat
end repeat
end repeat
end tell
return "no"
end run`;
  return await appleScript(script, [title, text], 10_000) === "yes";
}

export async function addSystemAlarm(start: number): Promise<void> {
  const shortcut = process.env.ALARM_SHORTCUT_NAME?.trim() || "Codex Alarm";
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-alarm-"));
  const input = path.join(directory, "alarm-time.txt");
  try {
    await writeFile(input, shortcutDateInput(start), "utf8");
    await execute("/usr/bin/shortcuts", ["run", shortcut, "--input-path", input], {
      timeout: 30_000, maxBuffer: 1024 * 1024,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function shortcutDateInput(value: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", timeZone: "Europe/Moscow",
  }).formatToParts(new Date(value));
  const take = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value || "";
  return `${take("year")}-${take("month")}-${take("day")} ${take("hour")}:${take("minute")}:${take("second")}`;
}

export async function activateCodexWithResume(workspace: string, threadId: string): Promise<string> {
  const command = `cd ${quote(workspace)} && codex resume ${quote(threadId)}`;
  await appleScript(`on run argv
set the clipboard to item 1 of argv
tell application "Codex" to activate
end run`, [command]);
  return command;
}

async function appleScript(script: string, args: string[] = [], timeout = 30_000): Promise<string> {
  const { stdout } = await execute("/usr/bin/osascript", ["-e", script, ...args], { timeout, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}
async function javaScript(script: string, timeout = 30_000): Promise<string> {
  const { stdout } = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}
function quote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
