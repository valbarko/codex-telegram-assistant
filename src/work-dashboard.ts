import path from "node:path";

import type { StoredThread } from "./codex-engine.js";
import type { WorkItem, WorkStatus } from "./storage.js";

export type ActiveWorkStatus = Extract<WorkStatus, "todo" | "queued" | "running" | "waiting">;

export interface UnifiedWorkItem {
  id: string;
  kind: "task" | "thread";
  title: string;
  status: ActiveWorkStatus;
  project: string;
  projectLabel: string;
  updatedAt: number;
}

export interface UnifiedWorkGroup {
  label: string;
  items: UnifiedWorkItem[];
}

export interface UnifiedWorkCounts {
  running: number;
  waiting: number;
  queued: number;
  todo: number;
}

const ACTIVE_STATUSES = new Set<WorkStatus>(["todo", "queued", "running", "waiting"]);

export function internalWorkThread(thread: StoredThread): boolean {
  return thread.title.trim().startsWith("Выполни запрос пользователя и верни только полезный результат.");
}

export function internalAssistantWorkspace(workspace: string, dataDirectory: string): boolean {
  const relative = path.relative(dataDirectory, workspace);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function mergeActiveWork(tasks: readonly WorkItem[], threads: readonly StoredThread[],
  aliases: Readonly<Record<string, string>>, excludedThreadIds: ReadonlySet<string> = new Set()): UnifiedWorkItem[] {
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const linkedThreadIds = new Set(tasks.map((task) => task.threadId).filter((id): id is string => Boolean(id)));
  const result: UnifiedWorkItem[] = [];

  for (const task of tasks) {
    if (!ACTIVE_STATUSES.has(task.status)) continue;
    const linked = task.threadId ? threadsById.get(task.threadId) : undefined;
    const project = task.project || linked?.workspace || "";
    result.push({
      id: task.id,
      kind: "task",
      title: task.title,
      status: task.status as ActiveWorkStatus,
      project,
      projectLabel: workProjectLabel(project, task.projectLabel, aliases),
      updatedAt: task.changedAt,
    });
  }

  for (const thread of threads) {
    if (thread.archived || linkedThreadIds.has(thread.id) || excludedThreadIds.has(thread.id)) continue;
    result.push({
      id: thread.id,
      kind: "thread",
      title: thread.title,
      status: "running",
      project: thread.workspace,
      projectLabel: workProjectLabel(thread.workspace, undefined, aliases),
      updatedAt: thread.updatedAt,
    });
  }

  return result.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function groupActiveWork(items: readonly UnifiedWorkItem[]): UnifiedWorkGroup[] {
  const groups = new Map<string, UnifiedWorkGroup>();
  for (const item of items) {
    const key = item.projectLabel.toLocaleLowerCase("ru-RU");
    const group = groups.get(key) ?? { label: item.projectLabel, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    (right.items[0]?.updatedAt ?? 0) - (left.items[0]?.updatedAt ?? 0));
}

export function countActiveWork(items: readonly UnifiedWorkItem[]): UnifiedWorkCounts {
  const counts: UnifiedWorkCounts = { running: 0, waiting: 0, queued: 0, todo: 0 };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

function workProjectLabel(project: string, explicit: string | undefined,
  aliases: Readonly<Record<string, string>>): string {
  const projectAlias = project ? aliases[project] || aliases[path.basename(project)] : undefined;
  if (projectAlias) return projectAlias;
  if (explicit?.trim()) return aliases[explicit.trim()] || explicit.trim();
  if (!project) return "Без проекта";
  return path.basename(project) || "Без проекта";
}
