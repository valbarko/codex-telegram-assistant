import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const RECORD = "~~~CTA_RECORD~~~";

export interface CalendarEntry { title: string; start: string; calendar: string; }

export async function upcomingCalendar(days = 7, maximum = 12): Promise<CalendarEntry[]> {
  const names = (await appleScript(`tell application "Calendar"
set AppleScript's text item delimiters to "${RECORD}"
return name of every calendar as text
end tell`)).split(RECORD).filter(Boolean);
  const script = `on run argv
tell application "Calendar"
set fromDate to current date
set untilDate to fromDate + (${Math.max(1, days)} * days)
set rows to {}
try
set cal to calendar (item 1 of argv)
set found to every event of cal whose start date ≥ fromDate and start date ≤ untilDate
repeat with entry in found
set end of rows to ((summary of entry as text) & "|||" & (start date of entry as text) & "|||" & (name of cal as text))
end repeat
end try
set AppleScript's text item delimiters to "${RECORD}"
return rows as text
end tell
end run`;
  const rows = await Promise.all(names.map((name) => appleScript(script, [name], 8_000).catch(() => "")));
  return rows.flatMap((result) => result.split(RECORD).map(parseCalendar).filter(present)).slice(0, maximum);
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
function parseCalendar(row: string): CalendarEntry | null { const [title, start, calendar] = row.split("|||"); return title && start && calendar ? { title, start, calendar } : null; }
function quote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
function present<T>(value: T | null): value is T { return value !== null; }
