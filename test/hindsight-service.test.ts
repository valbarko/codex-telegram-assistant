import { randomUUID } from "node:crypto";

import { HindsightClient } from "@vectorize-io/hindsight-client";
import { describe, expect, it, vi } from "vitest";

import { HindsightKnowledgeService, hindsightBankId } from "../src/hindsight-service.js";
import type { MemoryEvent } from "../src/storage.js";

function configuration(enabled = true) {
  return {
    hindsightEnabled: enabled,
    hindsightBaseUrl: "http://127.0.0.1:8888",
    hindsightApiKey: undefined,
    hindsightReflectBudget: "low" as const,
    hindsightTimeoutMs: 5_000,
    hindsightLiveBatchSize: 1,
    hindsightLiveFlushMs: 5,
  };
}

function memoryEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: randomUUID(),
    owner: "42",
    namespace: "global",
    role: "user",
    kind: "message",
    body: "Валентин предпочитает короткие практичные ответы",
    source: "telegram-text",
    createdAt: Date.parse("2026-07-26T10:00:00Z"),
    ...overrides,
  };
}

function fakeClient() {
  return {
    getVersion: vi.fn(async () => ({ api_version: "0.8.5", features: {} })),
    createBank: vi.fn(async () => ({})),
    retain: vi.fn(async () => ({})),
    retainBatch: vi.fn(async () => ({})),
    recall: vi.fn(async () => ({
      results: [{
        id: "fact-1",
        text: "Валентин предпочитает короткие практичные ответы.",
        type: "world",
        metadata: { memory_id: "source-1", source: "telegram-text" },
        scores: { final: 0.9 },
      }],
    })),
    reflect: vi.fn(async () => ({ text: "Предпочитает короткие практичные ответы." })),
    deleteDocument: vi.fn(async () => undefined),
  };
}

describe("HindsightKnowledgeService", () => {
  it("batches archived events and returns recalled and reflected personal context", async () => {
    const client = fakeClient();
    const service = new HindsightKnowledgeService(configuration(), client as unknown as HindsightClient);
    const event = memoryEvent();

    service.capture(event);
    const recalled = await service.recall(event.owner, "Какие ответы предпочитает Валентин?");
    const reflection = await service.reflect(event.owner, "Как мне лучше отвечать?");

    expect(recalled[0]).toMatchObject({
      text: "Валентин предпочитает короткие практичные ответы.",
      sourceMemoryId: "source-1",
      score: 0.9,
    });
    expect(reflection).toContain("короткие");
    expect(client.createBank).toHaveBeenCalledTimes(1);
    expect(client.retainBatch).toHaveBeenCalledWith(
      hindsightBankId(event.owner),
      [expect.objectContaining({
        content: event.body,
        document_id: `cta-memory-${event.id}`,
        metadata: expect.objectContaining({ memory_id: event.id, source: "telegram-text", trust: "direct" }),
      })],
      expect.objectContaining({
        async: true,
      }),
    );
    expect(service.status(event.owner)).toBe("Hindsight: готов");
  });

  it("removes the derived document when the source event is forgotten", async () => {
    const client = fakeClient();
    const service = new HindsightKnowledgeService(configuration(), client as unknown as HindsightClient);
    const event = memoryEvent();

    service.remove(event);
    await service.reflect(event.owner, "Что осталось?");

    expect(client.deleteDocument).toHaveBeenCalledWith(
      hindsightBankId(event.owner),
      `cta-memory-${event.id}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("submits chronological backfill batches with stable document ids", async () => {
    const client = fakeClient();
    const service = new HindsightKnowledgeService(configuration(), client as unknown as HindsightClient);
    const newer = memoryEvent({ id: "newer", createdAt: 2 });
    const older = memoryEvent({ id: "older", createdAt: 1 });

    expect(await service.backfill([newer, older], 1)).toBe(2);
    expect(client.retainBatch).toHaveBeenCalledTimes(2);
    expect(client.retainBatch.mock.calls[0][1][0]).toMatchObject({ document_id: "cta-memory-older" });
    expect(client.retainBatch.mock.calls[1][1][0]).toMatchObject({ document_id: "cta-memory-newer" });
  });

  it("keeps assistant output in the canonical archive but excludes it from derived knowledge", async () => {
    const client = fakeClient();
    const service = new HindsightKnowledgeService(configuration(), client as unknown as HindsightClient);

    service.capture(memoryEvent({ role: "assistant", kind: "response", source: "codex-final" }));
    await service.flush();

    expect(client.retainBatch).not.toHaveBeenCalled();
  });

  it("retains the owner's voice but excludes current and legacy forwarded speech", async () => {
    const client = fakeClient();
    const service = new HindsightKnowledgeService(configuration(), client as unknown as HindsightClient);

    service.capture(memoryEvent({ id: "own", role: "user", kind: "voice", source: "telegram-voice" }));
    service.capture(memoryEvent({ id: "forwarded", role: "user", kind: "voice", source: "telegram-forwarded-voice:Анна" }));
    service.capture(memoryEvent({ id: "legacy-forwarded", role: "user", kind: "voice", source: "telegram-voice:Анна" }));
    await service.flush();

    expect(client.retainBatch).toHaveBeenCalledTimes(1);
    expect(client.retainBatch.mock.calls[0][1]).toEqual([
      expect.objectContaining({ document_id: "cta-memory-own" }),
    ]);

    service.remove(memoryEvent({ id: "forwarded", role: "user", kind: "voice", source: "telegram-forwarded-voice:Анна" }));
    await service.flush();
    expect(client.deleteDocument).toHaveBeenCalledWith(
      hindsightBankId("42"),
      "cta-memory-forwarded",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("stays inert when the derived knowledge layer is disabled", async () => {
    const service = new HindsightKnowledgeService(configuration(false));
    service.capture(memoryEvent());

    expect(await service.recall("42", "Что ты знаешь?")).toEqual([]);
    expect(await service.reflect("42", "Что ты знаешь?")).toBeUndefined();
    expect(service.status("42")).toBe("Hindsight: выключен");
  });
});
