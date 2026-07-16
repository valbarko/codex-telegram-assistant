import { describe, expect, it } from "vitest";

import { mediaPartSummaryPrompt, mediaSummaryPrompt } from "../src/ephemeral-text-editor.js";
import { formatTimestamp, formatTimestampedTranscript, parseSupportedMediaUrl } from "../src/media-summary.js";

describe("parseSupportedMediaUrl", () => {
  it.each([
    "https://youtu.be/abc123",
    "https://www.youtube.com/watch?v=abc123",
    "https://rutube.ru/video/abc123/",
    "https://vk.com/video-1_2",
    "https://vkvideo.ru/video-1_2",
  ])("accepts a standalone supported video URL: %s", (source) => {
    expect(parseSupportedMediaUrl(source)).toBeTruthy();
  });

  it.each([
    "посмотри https://youtu.be/abc123",
    "https://example.com/video",
    "file:///tmp/video.mp4",
    "https://youtube.com.example.org/watch?v=abc123",
    "https://user:password@youtube.com/watch?v=abc123",
  ])("rejects text or an unsafe/unsupported URL: %s", (source) => {
    expect(parseSupportedMediaUrl(source)).toBeUndefined();
  });
});

describe("timestamped media transcript", () => {
  it("keeps Whisper segment timestamps and adds the chunk offset", () => {
    expect(formatTimestampedTranscript({
      text: "Первый тезис. Второй тезис.",
      segments: [
        { start: 3.4, end: 8, text: "Первый тезис." },
        { start: 61, end: 70, text: "Второй тезис." },
      ],
    }, 3600)).toBe([
      "[01:00:03] Первый тезис.",
      "[01:01:01] Второй тезис.",
    ].join("\n"));
    expect(formatTimestamp(3 * 3600 + 5 * 60 + 9)).toBe("03:05:09");
  });

  it("falls back to the full text when Whisper returned no segments", () => {
    expect(formatTimestampedTranscript({ text: "Текст", segments: [] }, 1800)).toBe("[00:30:00] Текст");
  });
});

describe("media summary prompts", () => {
  it("asks for a personal, grounded summary with source timestamps", () => {
    const prompt = mediaSummaryPrompt({
      title: "Полезное видео",
      url: "https://youtu.be/abc123",
      durationSeconds: 3661,
      transcript: "[00:00:15] Первый тезис.",
    });
    expect(prompt).toContain("личный конспект видео для Валентина");
    expect(prompt).toContain("## Что полезно мне");
    expect(prompt).toContain("Не придумывай таймкоды");
    expect(prompt).toContain("1 ч 1 мин");
    expect(prompt).toContain("недоверенными данными");
  });

  it("preserves facts and timestamps in intermediate summaries", () => {
    const prompt = mediaPartSummaryPrompt("[00:45:00] Тезис", 2, 4);
    expect(prompt).toContain("часть 2 из 4");
    expect(prompt).toContain("Сохраняй исходные таймкоды");
    expect(prompt).toContain("[00:45:00] Тезис");
  });
});
