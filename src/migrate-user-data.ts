import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { AssistantDatabase, type WorkStatus } from "./storage.js";

interface LegacyContext {
  contextKey?: string;
  threadId?: string;
  workspace?: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
}

const sourceDirectory = path.resolve(process.argv[2] || "");
const targetFile = path.resolve(process.argv[3] || "");
if (!process.argv[2] || !process.argv[3]) {
  throw new Error("Usage: npm run migrate -- <old-data-directory> <new-assistant.sqlite>");
}

const sourceFile = path.join(sourceDirectory, "assistant.sqlite");
if (!existsSync(sourceFile)) throw new Error(`Source database not found: ${sourceFile}`);

const target = new AssistantDatabase(targetFile);
const source = new Database(sourceFile, { readonly: true, fileMustExist: true });

let tasks = 0;
let captures = 0;
let memories = 0;
let alarms = 0;
let conversations = 0;

try {
  if (tableExists(source, "assistant_tasks")) {
    for (const row of source.prepare("SELECT * FROM assistant_tasks ORDER BY created_at").all() as Record<string, unknown>[]) {
      target.createTask({
        owner: string(row.chat_id), title: string(row.title), prompt: string(row.prompt) || string(row.description) || string(row.title),
        status: workStatus(row.status), project: optional(row.project_path), projectLabel: optional(row.project_label), dueAt: number(row.due_at),
      });
      tasks += 1;
    }
  }
  if (tableExists(source, "assistant_inbox")) {
    for (const row of source.prepare("SELECT * FROM assistant_inbox ORDER BY created_at").all() as Record<string, unknown>[]) {
      target.capture({
        owner: string(row.chat_id), kind: string(row.kind) || "text", body: string(row.content), sender: optional(row.sender),
        sourceTime: number(row.sent_at), state: captureState(row.status),
      });
      captures += 1;
    }
  }
  if (tableExists(source, "assistant_memory")) {
    for (const row of source.prepare("SELECT * FROM assistant_memory ORDER BY created_at").all() as Record<string, unknown>[]) {
      target.remember(string(row.chat_id), string(row.content), optional(row.tags));
      memories += 1;
    }
  }
  if (tableExists(source, "assistant_reminders")) {
    for (const row of source.prepare("SELECT * FROM assistant_reminders WHERE enabled=1 ORDER BY next_run_at").all() as Record<string, unknown>[]) {
      target.createAlarm({
        owner: string(row.chat_id), label: string(row.title), nextAt: number(row.next_run_at) ?? Date.now(),
        cadence: cadence(row.recurrence), mode: alarmMode(row.action), prompt: optional(row.prompt), project: optional(row.project_path),
      });
      alarms += 1;
    }
  }
  const contextFile = path.join(sourceDirectory, "contexts.json");
  if (existsSync(contextFile)) {
    const parsed = JSON.parse(readFileSync(contextFile, "utf8")) as unknown;
    const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as LegacyContext;
      if (!item.contextKey || !item.workspace) continue;
      target.saveConversation({
        context: item.contextKey, threadId: item.threadId, workspace: item.workspace, model: item.model,
        effort: item.reasoningEffort, profileId: normalizeProfile(item.launchProfileId),
      });
      conversations += 1;
    }
  }
} finally {
  source.close();
  target.close();
}

console.log(JSON.stringify({ tasks, captures, memories, alarms, conversations, target: targetFile }));

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function optional(value: unknown): string | undefined { const valueString = string(value).trim(); return valueString || undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function workStatus(value: unknown): WorkStatus {
  const candidate = string(value);
  return (["todo", "queued", "running", "waiting", "done", "cancelled"] as const).includes(candidate as WorkStatus) ? candidate as WorkStatus : "todo";
}
function captureState(value: unknown): "new" | "task" | "memory" | "discarded" {
  const candidate = string(value);
  return (["new", "task", "memory", "discarded"] as const).includes(candidate as never) ? candidate as "new" | "task" | "memory" | "discarded" : "new";
}
function cadence(value: unknown): "once" | "daily" | "weekdays" | "weekly" {
  const candidate = string(value);
  if (candidate === "none") return "once";
  return (["once", "daily", "weekdays", "weekly"] as const).includes(candidate as never) ? candidate as "once" | "daily" | "weekdays" | "weekly" : "once";
}
function alarmMode(value: unknown): "notify" | "codex" | "digest-morning" | "digest-evening" {
  const candidate = string(value);
  if (candidate === "run_codex" || candidate === "task") return "codex";
  return (["notify", "codex", "digest-morning", "digest-evening"] as const).includes(candidate as never) ? candidate as "notify" | "codex" | "digest-morning" | "digest-evening" : "notify";
}
function normalizeProfile(value: unknown): string {
  const candidate = string(value);
  if (/read/i.test(candidate)) return "readonly";
  if (/review|ask|request/i.test(candidate)) return "review";
  return "default";
}
