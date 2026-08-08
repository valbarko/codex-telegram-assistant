import { readFile } from "node:fs/promises";
import path from "node:path";

import { readConfiguration } from "./configuration.js";
import { MemoryService } from "./memory-service.js";
import {
  AssistantDatabase,
  type PersonalFactCategory,
  type PersonalFactStatus,
  type UpsertPersonalFactInput,
} from "./storage.js";

interface ProfileImportDocument {
  version: 1;
  facts: unknown[];
}

const categories = new Set<PersonalFactCategory>([
  "identity", "location", "education", "work", "project", "interest", "preference",
  "value", "relationship", "health", "goal", "style", "other",
]);
const statuses = new Set<PersonalFactStatus>(["current", "historical", "uncertain", "superseded"]);

const file = argument("--file") ?? process.argv[2];
if (!file) throw new Error("Usage: npm run profile:import -- --file /path/to/profile-facts.json");

const configuration = readConfiguration();
const owner = process.env.PROFILE_IMPORT_OWNER?.trim() || configuration.appleNotesImportOwner;
if (!owner) throw new Error("Set PROFILE_IMPORT_OWNER or APPLE_NOTES_IMPORT_OWNER");

const parsed = JSON.parse(await readFile(path.resolve(file), "utf8")) as ProfileImportDocument;
if (parsed.version !== 1 || !Array.isArray(parsed.facts)) throw new Error("Expected profile import document version 1");

const database = new AssistantDatabase(path.join(configuration.dataDirectory, "assistant.sqlite"));
try {
  const facts = parsed.facts.map((value, index) => parseFact(value, owner, index));
  for (const fact of facts) database.upsertPersonalFact(fact);
  const memory = new MemoryService(configuration.dataDirectory, configuration.memsearchExecutable, database);
  const view = await memory.personalContext(owner);
  console.log(`Канонический профиль обновлён: ${facts.length} фактов`);
  console.log(`ABOUT: ${path.join(view.directory, "ABOUT.md")}`);
} finally {
  database.close();
}

function parseFact(value: unknown, owner: string, index: number): UpsertPersonalFactInput {
  const row = object(value);
  if (!row) throw new Error(`Invalid fact at index ${index}`);
  const category = string(row.category) as PersonalFactCategory;
  const status = string(row.status) as PersonalFactStatus;
  if (!categories.has(category)) throw new Error(`Invalid fact category at index ${index}`);
  if (!statuses.has(status)) throw new Error(`Invalid fact status at index ${index}`);
  const confidence = Number(row.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Invalid fact confidence at index ${index}`);
  }
  return {
    id: required(row.id, "id", index),
    owner,
    category,
    statement: required(row.statement, "statement", index),
    subject: required(row.subject, "subject", index),
    predicate: required(row.predicate, "predicate", index),
    object: required(row.object, "object", index),
    status,
    confidence,
    source: optional(row.source),
    evidenceMemoryId: optional(row.evidenceMemoryId),
    validFrom: date(row.validFrom, "validFrom", index),
    validTo: date(row.validTo, "validTo", index),
    observedAt: date(row.observedAt, "observedAt", index, true)!,
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function required(value: unknown, field: string, index: number): string {
  const result = string(value);
  if (!result) throw new Error(`Missing ${field} at fact index ${index}`);
  return result;
}

function optional(value: unknown): string | undefined {
  return string(value) || undefined;
}

function date(value: unknown, field: string, index: number, requiredValue = false): number | undefined {
  if (value === undefined || value === null || value === "") {
    if (requiredValue) throw new Error(`Missing ${field} at fact index ${index}`);
    return undefined;
  }
  const result = typeof value === "number" ? value : Date.parse(string(value));
  if (!Number.isFinite(result)) throw new Error(`Invalid ${field} at fact index ${index}`);
  return result;
}
