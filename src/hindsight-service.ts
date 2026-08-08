import { createHash } from "node:crypto";

import {
  HindsightClient,
  type Budget,
  type MemoryItemInput,
} from "@vectorize-io/hindsight-client";

import type { AppConfiguration } from "./configuration.js";
import { logInternalError } from "./public-errors.js";
import type { MemoryEvent } from "./storage.js";

type HindsightConfiguration = Pick<AppConfiguration,
  "hindsightEnabled" | "hindsightBaseUrl" | "hindsightApiKey" | "hindsightReflectBudget" | "hindsightTimeoutMs" |
  "hindsightLiveBatchSize" | "hindsightLiveFlushMs">;

export interface KnowledgeRecallHit {
  id: string;
  text: string;
  type: string;
  context?: string;
  occurredStart?: string;
  mentionedAt?: string;
  documentId?: string;
  sourceMemoryId?: string;
  source?: string;
  score: number;
}

export interface DerivedKnowledgeLayer {
  capture(event: MemoryEvent): void;
  remove(event: MemoryEvent): void;
  recall(owner: string, query: string, project?: string): Promise<KnowledgeRecallHit[]>;
  reflect(owner: string, query: string, project?: string): Promise<string | undefined>;
  status(owner: string): string;
}

export class HindsightKnowledgeService implements DerivedKnowledgeLayer {
  private readonly client?: HindsightClient;
  private readonly banks = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();
  private readonly buffers = new Map<string, Map<string, MemoryEvent>>();
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();
  private readonly errors = new Set<string>();

  constructor(
    private readonly configuration: HindsightConfiguration,
    client?: HindsightClient,
  ) {
    if (configuration.hindsightEnabled) {
      this.client = client ?? new HindsightClient({
        baseUrl: configuration.hindsightBaseUrl,
        apiKey: configuration.hindsightApiKey,
        userAgent: "codex-telegram-assistant/0.1",
      });
    }
  }

  capture(event: MemoryEvent): void {
    if (!this.client || !shouldRetainInKnowledge(event)) return;
    const buffer = this.buffers.get(event.owner) ?? new Map<string, MemoryEvent>();
    buffer.set(event.id, event);
    this.buffers.set(event.owner, buffer);
    if (buffer.size >= this.configuration.hindsightLiveBatchSize) {
      void this.flushOwner(event.owner);
      return;
    }
    if (this.flushTimers.has(event.owner)) return;
    const timer = setTimeout(() => {
      this.flushTimers.delete(event.owner);
      void this.flushOwner(event.owner);
    }, this.configuration.hindsightLiveFlushMs);
    timer.unref();
    this.flushTimers.set(event.owner, timer);
  }

  remove(event: MemoryEvent): void {
    // A user event may have been retained by an older policy (for example,
    // legacy forwarded voice). Forget must still remove that derived document.
    if (!this.client || event.role === "assistant") return;
    this.buffers.get(event.owner)?.delete(event.id);
    void this.enqueue(event.owner, async () => {
      await this.ensureBank(event.owner);
      await this.client!.deleteDocument(hindsightBankId(event.owner), eventDocumentId(event), {
        signal: this.signal(),
      });
    });
  }

  async recall(owner: string, query: string, project?: string): Promise<KnowledgeRecallHit[]> {
    if (!this.client || !query.trim()) return [];
    await this.flush(owner);
    try {
      await this.ensureBank(owner);
      const response = await this.client.recall(hindsightBankId(owner), [
        query.trim(),
        project ? `Текущий проект: ${project}.` : "",
      ].filter(Boolean).join("\n"), {
        types: ["world", "experience", "observation"],
        preferObservations: true,
        maxTokens: 3_500,
        budget: "low",
        queryTimestamp: new Date().toISOString(),
        includeEntities: true,
        maxEntityTokens: 600,
        includeSourceFacts: true,
        maxSourceFactsTokens: 1_200,
        signal: this.signal(),
      });
      this.errors.delete(owner);
      return response.results.slice(0, 12).map((result) => ({
        id: result.id,
        text: result.text,
        type: result.type || "memory",
        context: result.context || undefined,
        occurredStart: result.occurred_start || undefined,
        mentionedAt: result.mentioned_at || undefined,
        documentId: result.document_id || undefined,
        sourceMemoryId: result.metadata?.memory_id,
        source: result.metadata?.source,
        score: result.scores?.final ?? 0,
      }));
    } catch (error) {
      this.report(owner, "Hindsight recall failed", error);
      return [];
    }
  }

  async reflect(owner: string, query: string, project?: string): Promise<string | undefined> {
    if (!this.client || !query.trim()) return undefined;
    await this.flush(owner);
    try {
      await this.ensureBank(owner);
      const response = await this.client.reflect(hindsightBankId(owner), query, {
        budget: this.configuration.hindsightReflectBudget,
        includeFacts: true,
        context: [
          "Ответ предназначен владельцу памяти Валентину.",
          "Отделяй подтверждённые факты от предположений и явно обозначай неопределённость.",
          project ? `Текущий проект: ${project}.` : "Текущий запрос не привязан к отдельному проекту.",
        ].join(" "),
        signal: this.signal(),
      });
      this.errors.delete(owner);
      return response.text.trim() || undefined;
    } catch (error) {
      this.report(owner, "Hindsight reflection failed", error);
      return undefined;
    }
  }

  async health(): Promise<string> {
    if (!this.client) throw new Error("Hindsight is disabled");
    const response = await this.client.getVersion({ signal: this.signal() });
    return response.api_version;
  }

  async backfill(events: readonly MemoryEvent[], batchSize = 25): Promise<number> {
    if (!this.client) throw new Error("Hindsight is disabled");
    const active = events.filter((event) => !event.deletedAt && shouldRetainInKnowledge(event))
      .sort((left, right) => left.createdAt - right.createdAt);
    if (!active.length) return 0;
    const owner = active[0].owner;
    if (active.some((event) => event.owner !== owner)) throw new Error("A Hindsight backfill batch must have one owner");
    await this.ensureBank(owner);
    for (let index = 0; index < active.length; index += batchSize) {
      const items = active.slice(index, index + batchSize).map(toMemoryItem);
      await this.client.retainBatch(hindsightBankId(owner), items, {
        async: true,
        signal: this.signal(),
      });
    }
    this.errors.delete(owner);
    return active.length;
  }

  status(owner: string): string {
    if (!this.client) return "Hindsight: выключен";
    if (this.errors.has(owner)) return "Hindsight: временно недоступен";
    const pending = (this.pending.get(owner) ?? 0) + (this.buffers.get(owner)?.size ?? 0);
    return pending ? `Hindsight: обновляется (${pending})` : "Hindsight: готов";
  }

  async flush(owner?: string): Promise<void> {
    const owners = owner ? [owner] : [...new Set([...this.buffers.keys(), ...this.queues.keys()])];
    await Promise.all(owners.map(async (currentOwner) => {
      await this.flushOwner(currentOwner);
      await this.queues.get(currentOwner);
    }));
  }

  private enqueue(owner: string, operation: () => Promise<void>): Promise<void> {
    this.pending.set(owner, (this.pending.get(owner) ?? 0) + 1);
    const previous = this.queues.get(owner) ?? Promise.resolve();
    const next = previous.then(operation).then(
      () => { this.errors.delete(owner); },
      (error) => this.report(owner, "Hindsight synchronization failed", error),
    ).finally(() => {
      const remaining = Math.max(0, (this.pending.get(owner) ?? 1) - 1);
      if (remaining) this.pending.set(owner, remaining);
      else this.pending.delete(owner);
      if (this.queues.get(owner) === next) this.queues.delete(owner);
    });
    this.queues.set(owner, next);
    return next;
  }

  private flushOwner(owner: string): Promise<void> {
    const timer = this.flushTimers.get(owner);
    if (timer) clearTimeout(timer);
    this.flushTimers.delete(owner);
    const buffer = this.buffers.get(owner);
    if (!buffer?.size) return this.queues.get(owner) ?? Promise.resolve();
    const events = [...buffer.values()].sort((left, right) => left.createdAt - right.createdAt);
    this.buffers.delete(owner);
    return this.enqueue(owner, async () => {
      await this.ensureBank(owner);
      await this.client!.retainBatch(hindsightBankId(owner), events.map(toMemoryItem), {
        async: true,
        signal: this.signal(),
      });
    });
  }

  private async ensureBank(owner: string): Promise<void> {
    if (!this.client) return;
    const existing = this.banks.get(owner);
    if (existing) return existing;
    const bank = this.client.createBank(hindsightBankId(owner), {
      name: "Личная память Валентина",
      retainMission: [
        "Создавай точную персональную память о владельце.",
        "Извлекай людей, отношения, события, даты, предпочтения, привычки, стиль общения, идеи, цели, планы и обязательства.",
        "Слова пользователя и его подтверждённые действия являются первичными свидетельствами.",
        "Текст ассистента считай предложением или гипотезой, пока пользователь его не подтвердил.",
      ].join(" "),
      reflectMission: [
        "Помогай Валентину понимать собственный контекст и принимать решения.",
        "Используй только память банка, отделяй факты от выводов, отмечай противоречия и степень уверенности.",
        "Предлагай практические следующие шаги, когда они следуют из сохранённого контекста.",
      ].join(" "),
      retainExtractionMode: "verbose",
      enableObservations: true,
      observationsMission: [
        "Выявляй устойчивые предпочтения, повторяющиеся паттерны, текущие цели, незакрытые обязательства и изменения во времени.",
        "Не превращай единичное высказывание в устойчивую характеристику без достаточных свидетельств.",
      ].join(" "),
      signal: this.signal(),
    }).then(() => undefined);
    this.banks.set(owner, bank);
    try {
      await bank;
    } catch (error) {
      this.banks.delete(owner);
      throw error;
    }
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.configuration.hindsightTimeoutMs);
  }

  private report(owner: string, message: string, error: unknown): void {
    this.errors.add(owner);
    logInternalError(`${message} for owner ${owner}`, error);
  }
}

export function hindsightBankId(owner: string): string {
  return `cta-${createHash("sha256").update(owner).digest("hex").slice(0, 20)}`;
}

function eventDocumentId(event: MemoryEvent): string {
  return `cta-memory-${event.id}`;
}

function eventContext(event: MemoryEvent): string {
  return [
    "Событие из личного архива владельца.",
    `Роль: ${event.role}.`,
    `Тип: ${event.kind}.`,
    event.source ? `Источник: ${event.source}.` : "",
    event.project ? `Проект: ${event.project}.` : "Глобальный контекст.",
    event.kind === "document"
      ? "Это личный документ: он может содержать цитаты, черновики или сведения о других людях, поэтому не считать каждую фразу автобиографическим фактом."
      : "",
    event.role === "assistant"
      ? "Это ответ ассистента: не считать его утверждения фактами о владельце без подтверждения пользователя."
      : "",
  ].filter(Boolean).join(" ");
}

function eventMetadata(event: MemoryEvent): Record<string, string> {
  return {
    memory_id: event.id,
    role: event.role,
    kind: event.kind,
    namespace: event.namespace,
    trust: event.kind === "explicit" ? "confirmed" : event.role === "user" ? "direct" : "observed",
    ...(event.source ? { source: event.source } : {}),
    ...(event.project ? { project: event.project } : {}),
  };
}

export function shouldRetainInKnowledge(event: MemoryEvent): boolean {
  if (event.role === "assistant") return false;
  if (
    event.source === "forwarded-voice-batch" ||
    event.source === "daily-summary" ||
    event.source?.startsWith("telegram-forwarded-voice:") ||
    event.source?.startsWith("telegram-voice:")
  ) return false;
  if (event.role === "user") return true;
  return event.source !== "telegram-command" && event.source !== "telegram-button";
}

function eventTags(event: MemoryEvent): string[] {
  return [
    `role:${event.role}`,
    `kind:${event.kind}`,
    `namespace:${event.namespace}`,
    ...(event.source ? [`source:${normalizeTag(event.source)}`] : []),
    ...(event.project ? [`project:${createHash("sha256").update(event.project).digest("hex").slice(0, 12)}`] : []),
  ];
}

function toMemoryItem(event: MemoryEvent): MemoryItemInput {
  return {
    content: event.body,
    timestamp: new Date(event.createdAt),
    context: eventContext(event),
    metadata: eventMetadata(event),
    document_id: eventDocumentId(event),
    update_mode: "replace",
    tags: eventTags(event),
  };
}

function normalizeTag(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}
