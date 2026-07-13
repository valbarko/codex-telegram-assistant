import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ForwardedVoiceBatcher, forwardedVoiceHeading, forwardedVoicePrompt,
  type ForwardedVoiceBatch, type ForwardedVoiceFragment } from "../src/forwarded-voice.js";

describe("forwarded voice batches", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collects rapidly forwarded fragments and resets the 45 second timer", async () => {
    const flushed: ForwardedVoiceBatch[] = [];
    const batcher = new ForwardedVoiceBatcher((batch) => flushed.push(batch));

    expect(batcher.add("chat:user:1", fragment("2", 2 * 60_000, "Второй"))).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(batcher.add("chat:user:1", fragment("1", 0, "Первый"))).toBe(2);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(flushed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.fragments.map((item) => item.transcript)).toEqual(["Первый", "Второй"]);
  });

  it("starts a new package when original messages are more than ten minutes apart", async () => {
    const flushed: ForwardedVoiceBatch[] = [];
    const batcher = new ForwardedVoiceBatcher((batch) => flushed.push(batch));

    batcher.add("chat:user:1", fragment("1", 0, "Первая тема"));
    expect(batcher.add("chat:user:1", fragment("2", 10 * 60_000 + 1, "Другая тема"))).toBe(1);
    expect(flushed.map((batch) => batch.fragments.map((item) => item.id))).toEqual([["1"]]);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(flushed.map((batch) => batch.fragments.map((item) => item.id))).toEqual([["1"], ["2"]]);
  });

  it("builds one metadata heading and preserves fragment boundaries for Codex", () => {
    const fragments = [fragment("1", Date.parse("2026-07-13T09:03:00+03:00"), "Первая мысль", 70),
      fragment("2", Date.parse("2026-07-13T09:08:00+03:00"), "Продолжение", 52)];

    expect(forwardedVoiceHeading(fragments)).toBe([
      "## Иван",
      "2 голосовых · 09:03–09:08",
      "Общая длительность: 2 мин 2 сек",
    ].join("\n\n"));
    const prompt = forwardedVoicePrompt(fragments);
    expect(prompt).toContain("Определи смысловую связность");
    expect(prompt).toContain("ФРАГМЕНТ 1 · 09:03\nПервая мысль");
    expect(prompt).toContain("ФРАГМЕНТ 2 · 09:08\nПродолжение");
  });
});

function fragment(id: string, sentAt: number, transcript: string, durationSeconds = 30): ForwardedVoiceFragment {
  return {
    id,
    sender: "Иван",
    senderKey: "user:1",
    sentAt,
    durationSeconds,
    transcript,
    progressMessageId: Number(id),
    chatId: 42,
  };
}
