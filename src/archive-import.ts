import { createHash } from "node:crypto";
import path from "node:path";

import type { MemoryService } from "./memory-service.js";
import type { MemoryEvent, MemoryKind, MemoryRole } from "./storage.js";

const TELEGRAM_BATCH_CHARACTERS = 20_000;

export interface ArchiveDocument {
  source: string;
  role: MemoryRole;
  kind: MemoryKind;
  body: string;
  sourceChangedAt: number;
}

export interface PreparedTelegramArchive {
  documents: ArchiveDocument[];
  chats: number;
  ownMessages: number;
  importedMessages: number;
  skippedEmpty: number;
  skippedTrivial: number;
  skippedDuplicate: number;
}

export interface PreparedClaudeArchive {
  documents: ArchiveDocument[];
  conversations: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  skippedWithoutVisibleText: number;
}

export interface PreparedChatGptArchive {
  documents: ArchiveDocument[];
  conversations: number;
  currentBranchMessages: number;
  userMessages: number;
  importedMessages: number;
  skippedAssistant: number;
  skippedHiddenOrTechnical: number;
  skippedBranchMessages: number;
  skippedEmpty: number;
  skippedTrivial: number;
  skippedDuplicate: number;
  skippedAttachmentParts: number;
}

export interface PreparedMarkdownDocument {
  documents: ArchiveDocument[];
  characters: number;
}

export interface ArchiveUpsertResult {
  created: number;
  updated: number;
  unchanged: number;
  forgotten: number;
  skipped: number;
  changedEvents: MemoryEvent[];
}

interface TelegramMessage {
  id?: unknown;
  type?: unknown;
  date?: unknown;
  date_unixtime?: unknown;
  from_id?: unknown;
  text?: unknown;
}

interface TelegramEntry {
  id: string;
  timestamp: number;
  text: string;
}

interface ChatGptEntry {
  id: string;
  timestamp: number;
  text: string;
}

export function prepareTelegramExport(content: string, maximumBatchCharacters = TELEGRAM_BATCH_CHARACTERS): PreparedTelegramArchive {
  const root = object(JSON.parse(content));
  const personal = object(root?.personal_information);
  const userId = numberValue(personal?.user_id);
  if (!root || !userId) throw new Error("Telegram export does not contain personal_information.user_id");
  const chats = arrayValue(object(root.chats)?.list);
  const self = `user${userId}`;
  const seen = new Set<string>();
  const documents: ArchiveDocument[] = [];
  const stats = {
    chats: chats.length,
    ownMessages: 0,
    importedMessages: 0,
    skippedEmpty: 0,
    skippedTrivial: 0,
    skippedDuplicate: 0,
  };

  for (const chatValue of chats) {
    const chat = object(chatValue);
    if (!chat) continue;
    const chatId = stringValue(chat.id) || String(numberValue(chat.id));
    if (!chatId) continue;
    const chatName = stringValue(chat.name) || "Без названия";
    const chatType = stringValue(chat.type) || "unknown";
    const byMonth = new Map<string, TelegramEntry[]>();
    for (const messageValue of arrayValue(chat.messages)) {
      const message = object(messageValue) as TelegramMessage | undefined;
      if (!message || message.type !== "message" || stringValue(message.from_id) !== self) continue;
      stats.ownMessages += 1;
      const text = normalizeText(telegramText(message.text));
      if (!text) {
        stats.skippedEmpty += 1;
        continue;
      }
      if (usefulCharacters(text) < 4) {
        stats.skippedTrivial += 1;
        continue;
      }
      const duplicateKey = text.replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU");
      if (seen.has(duplicateKey)) {
        stats.skippedDuplicate += 1;
        continue;
      }
      seen.add(duplicateKey);
      const timestamp = telegramTimestamp(message);
      const month = monthKey(message.date, timestamp);
      const entries = byMonth.get(month) ?? [];
      entries.push({
        id: stringValue(message.id) || String(numberValue(message.id)),
        timestamp,
        text,
      });
      byMonth.set(month, entries);
      stats.importedMessages += 1;
    }

    for (const [month, entries] of [...byMonth].sort(([left], [right]) => left.localeCompare(right))) {
      entries.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
      const batches = batchTelegramEntries(entries, maximumBatchCharacters);
      for (let index = 0; index < batches.length; index++) {
        const batch = batches[index]!;
        documents.push({
          source: archiveSource("telegram-export", `${chatType}:${chatId}:${month}:${index}`),
          role: "user",
          kind: "document",
          sourceChangedAt: batch.at(-1)?.timestamp || 1,
          body: [
            `Telegram: собственные сообщения`,
            `Чат: ${chatName}`,
            `Тип чата: ${chatType}`,
            `Период: ${month}`,
            `Часть: ${index + 1}/${batches.length}`,
            "",
            ...batch.map(renderTelegramEntry),
          ].join("\n"),
        });
      }
    }
  }

  return { documents, ...stats };
}

export function prepareClaudeConversations(content: string): PreparedClaudeArchive {
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Claude conversations.json must contain an array");
  const documents: ArchiveDocument[] = [];
  let messages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let skippedWithoutVisibleText = 0;

  for (const conversationValue of parsed) {
    const conversation = object(conversationValue);
    if (!conversation) continue;
    const conversationId = stringValue(conversation.uuid);
    if (!conversationId) continue;
    const title = stringValue(conversation.name) || "Без названия";
    for (const messageValue of arrayValue(conversation.chat_messages)) {
      const message = object(messageValue);
      if (!message) continue;
      messages += 1;
      const sender = stringValue(message.sender);
      const role: MemoryRole | undefined = sender === "human" ? "user" : sender === "assistant" ? "assistant" : undefined;
      if (!role) {
        skippedWithoutVisibleText += 1;
        continue;
      }
      const text = normalizeText(claudeVisibleText(message));
      if (!text) {
        skippedWithoutVisibleText += 1;
        continue;
      }
      const messageId = stringValue(message.uuid);
      if (!messageId) {
        skippedWithoutVisibleText += 1;
        continue;
      }
      if (role === "user") userMessages += 1;
      else assistantMessages += 1;
      const timestamp = isoTimestamp(message.created_at) || isoTimestamp(conversation.created_at) || 1;
      documents.push({
        source: archiveSource("claude-export", `${conversationId}:${messageId}`),
        role,
        kind: "document",
        sourceChangedAt: timestamp,
        body: [
          `Claude chat: ${title}`,
          `Роль: ${role === "user" ? "пользователь" : "ассистент"}`,
          `Дата: ${new Date(timestamp).toISOString()}`,
          "",
          text,
        ].join("\n"),
      });
    }
  }

  return {
    documents,
    conversations: parsed.length,
    messages,
    userMessages,
    assistantMessages,
    skippedWithoutVisibleText,
  };
}

export function prepareChatGptConversations(
  contents: readonly string[],
  maximumBatchCharacters = TELEGRAM_BATCH_CHARACTERS,
): PreparedChatGptArchive {
  const documents: ArchiveDocument[] = [];
  const seen = new Set<string>();
  const stats = {
    conversations: 0,
    currentBranchMessages: 0,
    userMessages: 0,
    importedMessages: 0,
    skippedAssistant: 0,
    skippedHiddenOrTechnical: 0,
    skippedBranchMessages: 0,
    skippedEmpty: 0,
    skippedTrivial: 0,
    skippedDuplicate: 0,
    skippedAttachmentParts: 0,
  };

  for (const content of contents) {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) throw new Error("ChatGPT conversation files must contain arrays");
    stats.conversations += parsed.length;
    for (const conversationValue of parsed) {
      const conversation = object(conversationValue);
      if (!conversation) continue;
      const conversationId = stringValue(conversation.id) || stringValue(conversation.conversation_id);
      if (!conversationId) continue;
      const title = stringValue(conversation.title) || "Без названия";
      const mapping = object(conversation.mapping) ?? {};
      const currentPath = chatGptCurrentPath(mapping, stringValue(conversation.current_node));
      const currentIds = new Set(currentPath.map((node) => stringValue(node.id)).filter(Boolean));
      stats.skippedBranchMessages += Object.entries(mapping).filter(([nodeId, value]) => {
        const node = object(value);
        return node && !currentIds.has(nodeId) && object(node.message);
      }).length;
      const entries: ChatGptEntry[] = [];

      for (const node of currentPath) {
        const message = object(node.message);
        if (!message) continue;
        stats.currentBranchMessages += 1;
        const role = stringValue(object(message.author)?.role);
        const contentValue = object(message.content);
        const contentType = stringValue(contentValue?.content_type);
        if (role === "assistant") {
          if (contentType === "thoughts" || contentType === "reasoning_recap") stats.skippedHiddenOrTechnical += 1;
          else stats.skippedAssistant += 1;
          continue;
        }
        if (role !== "user" || (contentType !== "text" && contentType !== "multimodal_text")) {
          stats.skippedHiddenOrTechnical += 1;
          continue;
        }
        stats.userMessages += 1;
        const extracted = chatGptVisibleText(contentValue);
        stats.skippedAttachmentParts += extracted.skippedAttachments;
        const text = normalizeText(extracted.text);
        if (!text) {
          stats.skippedEmpty += 1;
          continue;
        }
        if (usefulCharacters(text) < 4) {
          stats.skippedTrivial += 1;
          continue;
        }
        const duplicateKey = text.replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU");
        if (seen.has(duplicateKey)) {
          stats.skippedDuplicate += 1;
          continue;
        }
        seen.add(duplicateKey);
        entries.push({
          id: stringValue(message.id) || stringValue(node.id),
          timestamp: chatGptTimestamp(message.create_time) || chatGptTimestamp(conversation.create_time) || 1,
          text,
        });
        stats.importedMessages += 1;
      }

      entries.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
      const batches = batchChatGptEntries(entries, maximumBatchCharacters);
      for (let index = 0; index < batches.length; index++) {
        const batch = batches[index]!;
        documents.push({
          source: archiveSource("chatgpt-export", `${conversationId}:user:${index}`),
          role: "user",
          kind: "document",
          sourceChangedAt: batch.at(-1)?.timestamp || 1,
          body: [
            "ChatGPT: сообщения пользователя",
            `Чат: ${title}`,
            `Часть: ${index + 1}/${batches.length}`,
            "",
            ...batch.map(renderChatGptEntry),
          ].join("\n"),
        });
      }
    }
  }

  return { documents, ...stats };
}

export function prepareMarkdownDocument(filePath: string, content: string, sourceChangedAt: number): PreparedMarkdownDocument {
  const resolvedPath = path.resolve(filePath);
  const displayName = path.basename(resolvedPath).replace(/[-_]+/g, " ");
  const normalized = normalizeText(content);
  if (!normalized) throw new Error(`Markdown file is empty: ${resolvedPath}`);
  if (!Number.isFinite(sourceChangedAt) || sourceChangedAt <= 0) {
    throw new Error(`Markdown file has an invalid modification time: ${resolvedPath}`);
  }
  return {
    characters: normalized.length,
    documents: [{
      source: archiveSource("markdown-file", resolvedPath),
      role: "user",
      kind: "document",
      sourceChangedAt,
      body: [
        "Локальный Markdown-документ: подтверждённый пользовательский источник",
        `Файл: ${displayName}`,
        `Дата изменения: ${new Date(sourceChangedAt).toISOString()}`,
        "",
        normalized,
      ].join("\n"),
    }],
  };
}

export async function upsertArchiveDocuments(
  owner: string,
  documents: readonly ArchiveDocument[],
  memory: Pick<MemoryService, "upsertExternal">,
): Promise<ArchiveUpsertResult> {
  const result: ArchiveUpsertResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    forgotten: 0,
    skipped: 0,
    changedEvents: [],
  };
  for (const document of documents) {
    const imported = await memory.upsertExternal({
      owner,
      body: document.body,
      role: document.role,
      kind: document.kind,
      source: document.source,
      sourceChangedAt: document.sourceChangedAt,
    }, { deferDerived: true });
    if (!imported) {
      result.skipped += 1;
      continue;
    }
    result[imported.status] += 1;
    if (imported.status === "created" || imported.status === "updated") result.changedEvents.push(imported.event);
  }
  return result;
}

export function archiveSource(
  provider: "telegram-export" | "claude-export" | "chatgpt-export" | "markdown-file",
  externalId: string,
): string {
  return `${provider}:${createHash("sha256").update(externalId).digest("hex").slice(0, 32)}`;
}

export function formatArchiveUpsertResult(label: string, result: ArchiveUpsertResult): string {
  return `${label}: добавлено ${result.created}, обновлено ${result.updated}, без изменений ${result.unchanged}, ` +
    `ранее забыто ${result.forgotten}, пропущено после фильтра ${result.skipped}`;
}

function batchTelegramEntries(entries: readonly TelegramEntry[], maximumCharacters: number): TelegramEntry[][] {
  const result: TelegramEntry[][] = [];
  let current: TelegramEntry[] = [];
  let characters = 0;
  for (const entry of entries) {
    const size = renderTelegramEntry(entry).length + 2;
    if (current.length && characters + size > maximumCharacters) {
      result.push(current);
      current = [];
      characters = 0;
    }
    current.push(entry);
    characters += size;
  }
  if (current.length) result.push(current);
  return result;
}

function renderTelegramEntry(entry: TelegramEntry): string {
  return [`### ${new Date(entry.timestamp).toISOString()} · message ${entry.id}`, "", entry.text, ""].join("\n");
}

function batchChatGptEntries(entries: readonly ChatGptEntry[], maximumCharacters: number): ChatGptEntry[][] {
  const result: ChatGptEntry[][] = [];
  let current: ChatGptEntry[] = [];
  let characters = 0;
  for (const entry of entries) {
    const size = renderChatGptEntry(entry).length + 2;
    if (current.length && characters + size > maximumCharacters) {
      result.push(current);
      current = [];
      characters = 0;
    }
    current.push(entry);
    characters += size;
  }
  if (current.length) result.push(current);
  return result;
}

function renderChatGptEntry(entry: ChatGptEntry): string {
  return [`### ${new Date(entry.timestamp).toISOString()} · message ${entry.id}`, "", entry.text, ""].join("\n");
}

function telegramText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    return stringValue(object(part)?.text);
  }).join("");
}

function claudeVisibleText(message: Record<string, unknown>): string {
  const text = stringValue(message.text).trim();
  if (text) return text;
  return arrayValue(message.content).flatMap((block) => {
    const value = object(block);
    return value?.type === "text" ? [stringValue(value.text)] : [];
  }).filter(Boolean).join("\n\n");
}

function chatGptCurrentPath(mapping: Record<string, unknown>, currentNode: string): Record<string, unknown>[] {
  const reversed: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let nodeId = currentNode;
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId);
    const node = object(mapping[nodeId]);
    if (!node) break;
    reversed.push({ ...node, id: nodeId });
    nodeId = stringValue(node.parent);
  }
  return reversed.reverse();
}

function chatGptVisibleText(content: Record<string, unknown> | undefined): { text: string; skippedAttachments: number } {
  const text: string[] = [];
  let skippedAttachments = 0;
  for (const part of arrayValue(content?.parts)) {
    if (typeof part === "string") {
      if (part.trim()) text.push(part);
      continue;
    }
    const value = object(part);
    if (value && typeof value.text === "string") {
      if (value.text.trim()) text.push(value.text);
    } else if (value) {
      skippedAttachments += 1;
    }
  }
  return { text: text.join("\n\n"), skippedAttachments };
}

function chatGptTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? Math.round(value) : Math.round(value * 1_000);
  }
  return isoTimestamp(value);
}

function telegramTimestamp(message: TelegramMessage): number {
  const unix = Number(message.date_unixtime);
  if (Number.isFinite(unix) && unix > 0) return unix * 1_000;
  const parsed = Date.parse(stringValue(message.date));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function monthKey(value: unknown, timestamp: number): string {
  const date = stringValue(value);
  if (/^\d{4}-\d{2}/.test(date)) return date.slice(0, 7);
  return new Date(timestamp).toISOString().slice(0, 7);
}

function isoTimestamp(value: unknown): number | undefined {
  const parsed = Date.parse(stringValue(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

function usefulCharacters(value: string): number {
  return value.replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, "").length;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
