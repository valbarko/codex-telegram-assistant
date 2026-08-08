import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { understandAlarm } from "./reminder-language.js";

export type TaskPriority = "стратегический" | "высокий" | "обычный" | "низкий";
export type TaskUrgency = "срочно" | "обычно" | "потом";

export interface TaskProject {
  code: "ГМК" | "ТВК" | "ГМД";
  name: string;
  workspace: string;
}

export interface ParsedWorkTask {
  title: string;
  source: string;
  project?: TaskProject;
  dueAt?: number;
  priority: TaskPriority;
  urgency: TaskUrgency;
  createdAt: number;
}

const PROJECTS = [
  { code: "ГМК", name: "Где мои клиенты", folder: "gde-moi-klienty", aliases: ["гмк", "где мои клиенты"] },
  { code: "ТВК", name: "Тренер в кармане", folder: "trenervkarmane", aliases: ["твк", "тренер в кармане"] },
  { code: "ГМД", name: "Где мои деньги", folder: "gde-moi-dengi", aliases: ["гмд", "где мои деньги"] },
] as const;

const PROJECT_MARKER = "(?:гмк|твк|гмд|где\\s+мои\\s+клиенты|тренер\\s+в\\s+кармане|где\\s+мои\\s+деньги)";

export function parseWorkTasks(source: string, homeDirectory: string, now = Date.now()): ParsedWorkTask[] {
  return splitTasks(source).map((raw) => {
    const project = detectProject(raw, homeDirectory);
    const temporal = understandAlarm(raw, new Date(now));
    const priority = taskPriority(raw);
    const dueAt = temporal?.at;
    const urgency = taskUrgency(raw, dueAt, now);
    return {
      title: cleanTaskTitle(raw, project),
      source: raw,
      project,
      dueAt,
      priority,
      urgency,
      createdAt: now,
    };
  }).filter((task) => task.title.length > 0);
}

export class WorkTaskArchive {
  readonly file: string;
  private queue = Promise.resolve();

  constructor(root: string) {
    this.file = path.join(root, "Рабочие задачи", "РАБОЧИЕ ЗАДАЧИ.md");
  }

  save(tasks: readonly ParsedWorkTask[]): Promise<string> {
    const operation = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const existing = await readFile(this.file, "utf8").catch(() => "");
      const heading = existing ? "" : "# РАБОЧИЕ ЗАДАЧИ\n\n";
      const body = tasks.map(markdownTask).join("\n");
      await appendFile(this.file, `${heading}${body}`, "utf8");
      return this.file;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export function taskNotesHtml(task: ParsedWorkTask): string {
  const project = task.project ? `[${task.project.code}] ` : "";
  const due = task.dueAt ? ` · срок ${formatDate(task.dueAt)}` : "";
  return `<p>☐ <b>${escapeHtml(project)}</b>${escapeHtml(task.title)}</p>`
    + `<p><small>Добавлено ${escapeHtml(formatDate(task.createdAt))}${due}`
    + ` · приоритет ${escapeHtml(task.priority)} · срочность ${escapeHtml(task.urgency)}</small></p>`;
}

export function taskChecklistText(task: ParsedWorkTask): string {
  const project = task.project ? `[${task.project.code}] ` : "[БЕЗ ПРОЕКТА] ";
  const due = task.dueAt ? ` · срок ${formatDate(task.dueAt)}` : "";
  return `${project}${task.title} · приоритет ${task.priority} · ${task.urgency}${due}`;
}

export function taskSummary(task: ParsedWorkTask): string {
  const project = task.project ? `${task.project.code} · ${task.project.name}` : "Без проекта";
  const due = task.dueAt ? formatDate(task.dueAt) : "без срока";
  return `${project} · ${task.priority} · ${task.urgency} · ${due}`;
}

function splitTasks(source: string): string[] {
  const marked = source.trim()
    .replace(/\r/g, "")
    .replace(new RegExp(`([.!?])\\s+(?=${PROJECT_MARKER}(?:\\s|[:—–-]|$))`, "giu"), "$1\n");
  return marked.split(/\n+|;\s*/u)
    .map((part) => part.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, "").trim())
    .filter(Boolean);
}

function detectProject(source: string, homeDirectory: string): TaskProject | undefined {
  const normalized = source.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ");
  const found = PROJECTS.find((project) => project.aliases.some((alias) => normalized.includes(alias)));
  if (!found) return undefined;
  return {
    code: found.code,
    name: found.name,
    workspace: path.join(homeDirectory, "WORK", found.folder),
  };
}

function cleanTaskTitle(source: string, project: TaskProject | undefined): string {
  let title = source.trim()
    .replace(/^\s*(?:задача|задачи)\s*[:—–-]?\s*/iu, "")
    .replace(/^\s*(?:срочно|важно)\s*[:—–-]?\s*/iu, "")
    .replace(/^\s*(?:стратегическая|стратегический)\s+(?:задача\s*)?/iu, "");
  if (project) {
    const aliases = PROJECTS.find((candidate) => candidate.code === project.code)?.aliases ?? [];
    for (const alias of aliases) {
      const expression = alias.replace(/\s+/g, "\\s+");
      title = title.replace(new RegExp(`^\\s*(?:(?:по|для)\\s+(?:проекта?\\s+)?)?${expression}\\s*[:—–-]?\\s*`, "iu"), "");
    }
  }
  return title.replace(/[.!?]+$/u, "").replace(/\s+/g, " ").trim();
}

function taskPriority(source: string): TaskPriority {
  const value = source.toLocaleLowerCase("ru-RU");
  if (/стратегич/u.test(value)) return "стратегический";
  if (/(?:высокий|первый|максимальный)\s+приоритет|приоритет\s*[1а]|(?:^|\s)важно(?:\s|$|[,:;.!])/u.test(value)) return "высокий";
  if (/(?:низкий|последний)\s+приоритет|приоритет\s*[3в]|когда-нибудь/u.test(value)) return "низкий";
  return "обычный";
}

function taskUrgency(source: string, dueAt: number | undefined, now: number): TaskUrgency {
  const value = source.toLocaleLowerCase("ru-RU");
  if (/не\s+срочно|можно\s+(?:отложить|потом)|когда-нибудь|не\s+горит/u.test(value)) return "потом";
  if (/(?:^|\s)срочно(?:\s|$|[,:;.!])|как\s+можно\s+быстрее|до\s+конца\s+дня/u.test(value)) return "срочно";
  if (dueAt !== undefined && dueAt - now <= 48 * 60 * 60_000) return "срочно";
  return "обычно";
}

function markdownTask(task: ParsedWorkTask): string {
  const project = task.project ? `${task.project.code} — ${task.project.name}` : "Без проекта";
  const due = task.dueAt ? formatDate(task.dueAt) : "—";
  return [
    `- [ ] **[${project}]** ${task.title}`,
    `  - Добавлено: ${formatDate(task.createdAt)}`,
    `  - Срок: ${due}`,
    `  - Приоритет: ${task.priority}`,
    `  - Срочность: ${task.urgency}`,
    "",
  ].join("\n");
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
