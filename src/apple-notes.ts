import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MemoryService } from "./memory-service.js";
import { logInternalError } from "./public-errors.js";

const execute = promisify(execFile);
const DELETED_FOLDER_NAMES = new Set(["recently deleted", "недавно удаленные", "недавно удалённые"]);

export interface AppleNoteDocument {
  externalId: string;
  account: string;
  folderPath: readonly string[];
  title: string;
  plaintext: string;
  createdAt: number;
  modifiedAt: number;
  passwordProtected: boolean;
  shared: boolean;
}

export interface AppleNotesImportConfiguration {
  enabled: boolean;
  owner?: string;
  intervalMs: number;
  includeProtected: boolean;
}

export interface AppleNotesImportResult {
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  forgotten: number;
  skippedProtected: number;
  skippedShared: number;
  skippedDeleted: number;
  skippedEmpty: number;
}

type AppleNotesReader = () => Promise<AppleNoteDocument[]>;

export class AppleNotesImporter {
  private timer?: NodeJS.Timeout;
  private active?: Promise<AppleNotesImportResult>;

  constructor(
    private readonly configuration: AppleNotesImportConfiguration,
    private readonly memory: Pick<MemoryService, "upsertExternal">,
    private readonly reader: AppleNotesReader = readAppleNotes,
  ) {}

  async start(): Promise<AppleNotesImportResult | undefined> {
    if (!this.configuration.enabled || !this.configuration.owner) return undefined;
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.sync().catch((error) => logInternalError("Scheduled Apple Notes import failed", error));
      }, this.configuration.intervalMs);
      this.timer.unref();
    }
    return this.sync();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sync(): Promise<AppleNotesImportResult> {
    if (!this.configuration.enabled) throw new Error("Apple Notes import is disabled");
    if (!this.configuration.owner) throw new Error("Apple Notes import owner is not configured");
    if (this.active) return this.active;
    const operation = this.performSync();
    this.active = operation;
    try {
      return await operation;
    } finally {
      if (this.active === operation) this.active = undefined;
    }
  }

  private async performSync(): Promise<AppleNotesImportResult> {
    const owner = this.configuration.owner!;
    const notes = deduplicateNotes(await this.reader());
    const result: AppleNotesImportResult = {
      scanned: notes.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      forgotten: 0,
      skippedProtected: 0,
      skippedShared: 0,
      skippedDeleted: 0,
      skippedEmpty: 0,
    };
    for (const note of notes) {
      if (note.shared) {
        result.skippedShared += 1;
        continue;
      }
      if (note.folderPath.some((folder) => DELETED_FOLDER_NAMES.has(folder.trim().toLocaleLowerCase("ru-RU")))) {
        result.skippedDeleted += 1;
        continue;
      }
      if (note.passwordProtected && !this.configuration.includeProtected) {
        result.skippedProtected += 1;
        continue;
      }
      const plaintext = normalizePlaintext(note.plaintext);
      if (!plaintext) {
        if (note.passwordProtected) result.skippedProtected += 1;
        else result.skippedEmpty += 1;
        continue;
      }
      const imported = await this.memory.upsertExternal({
        owner,
        role: "user",
        kind: "document",
        source: appleNoteSource(note.externalId),
        sourceChangedAt: validTimestamp(note.modifiedAt) ?? validTimestamp(note.createdAt) ?? Date.now(),
        body: renderAppleNote(note, plaintext),
      });
      if (!imported) {
        result.skippedEmpty += 1;
        continue;
      }
      result[imported.status] += 1;
    }
    return result;
  }
}

export async function readAppleNotes(): Promise<AppleNoteDocument[]> {
  if (process.platform !== "darwin") throw new Error("Apple Notes import requires macOS");
  const script = `
var app = Application("Notes")
var rows = []
function safe(call, fallback) {
  try { return call() } catch (_) { return fallback }
}
function timestamp(value) {
  try {
    var date = value instanceof Date ? value : new Date(value)
    var result = date.getTime()
    return isFinite(result) ? result : 0
  } catch (_) { return 0 }
}
function walk(account, folder, parents, inheritedShared) {
  var folderName = String(safe(function () { return folder.name() }, ""))
  var path = parents.concat(folderName ? [folderName] : [])
  var folderShared = inheritedShared || Boolean(safe(function () { return folder.shared() }, false))
  var notes = safe(function () { return folder.notes() }, [])
  for (var index = 0; index < notes.length; index++) {
    var note = notes[index]
    var protectedNote = Boolean(safe(function () { return note.passwordProtected() }, false))
    rows.push({
      externalId: String(safe(function () { return note.id() }, "")),
      account: String(safe(function () { return account.name() }, "")),
      folderPath: path,
      title: String(safe(function () { return note.name() }, "")),
      plaintext: String(safe(function () { return note.plaintext() }, "")),
      createdAt: timestamp(safe(function () { return note.creationDate() }, 0)),
      modifiedAt: timestamp(safe(function () { return note.modificationDate() }, 0)),
      passwordProtected: protectedNote,
      shared: folderShared || Boolean(safe(function () { return note.shared() }, false))
    })
  }
  var children = safe(function () { return folder.folders() }, [])
  for (var child = 0; child < children.length; child++) walk(account, children[child], path, folderShared)
}
var accounts = app.accounts()
for (var accountIndex = 0; accountIndex < accounts.length; accountIndex++) {
  var account = accounts[accountIndex]
  var folders = safe(function () { return account.folders() }, [])
  for (var folderIndex = 0; folderIndex < folders.length; folderIndex++) {
    walk(account, folders[folderIndex], [], false)
  }
}
JSON.stringify({ version: 1, notes: rows })
`;
  const { stdout } = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  return parseAppleNotes(stdout);
}

export function parseAppleNotes(content: string): AppleNoteDocument[] {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { notes?: unknown }).notes)) {
    throw new Error("Invalid Apple Notes response");
  }
  return (parsed as { notes: unknown[] }).notes.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const externalId = stringValue(row.externalId);
    if (!externalId) return [];
    return [{
      externalId,
      account: stringValue(row.account),
      folderPath: Array.isArray(row.folderPath) ? row.folderPath.map(stringValue).filter(Boolean) : [],
      title: stringValue(row.title),
      plaintext: stringValue(row.plaintext),
      createdAt: numberValue(row.createdAt),
      modifiedAt: numberValue(row.modifiedAt),
      passwordProtected: row.passwordProtected === true,
      shared: row.shared === true,
    }];
  });
}

export function appleNoteSource(externalId: string): string {
  return `apple-notes:${createHash("sha256").update(externalId).digest("hex").slice(0, 32)}`;
}

export function formatAppleNotesImportResult(result: AppleNotesImportResult): string {
  return [
    `Apple Notes: просмотрено ${result.scanned}`,
    `добавлено ${result.created}`,
    `обновлено ${result.updated}`,
    `без изменений ${result.unchanged}`,
    `ранее забыто ${result.forgotten}`,
    `защищённых пропущено ${result.skippedProtected}`,
    `общих пропущено ${result.skippedShared}`,
    `удалённых пропущено ${result.skippedDeleted}`,
    `пустых пропущено ${result.skippedEmpty}`,
  ].join(", ");
}

function deduplicateNotes(notes: readonly AppleNoteDocument[]): AppleNoteDocument[] {
  const unique = new Map<string, AppleNoteDocument>();
  for (const note of notes) {
    const previous = unique.get(note.externalId);
    if (!previous || note.modifiedAt >= previous.modifiedAt) unique.set(note.externalId, note);
  }
  return [...unique.values()].sort((left, right) => left.modifiedAt - right.modifiedAt);
}

function renderAppleNote(note: AppleNoteDocument, plaintext: string): string {
  const folder = [note.account, ...note.folderPath].filter(Boolean).join(" / ");
  return [
    `Apple Notes: ${oneLine(note.title) || "Без названия"}`,
    folder ? `Папка: ${folder}` : "",
    validTimestamp(note.createdAt) ? `Создано: ${new Date(note.createdAt).toISOString()}` : "",
    validTimestamp(note.modifiedAt) ? `Изменено: ${new Date(note.modifiedAt).toISOString()}` : "",
    "",
    plaintext,
  ].filter((line, index, rows) => line || (index > 0 && rows[index - 1] !== "")).join("\n");
}

function normalizePlaintext(value: string): string {
  return value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function validTimestamp(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
