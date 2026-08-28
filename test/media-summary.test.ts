import { describe, expect, it } from "vitest";

import { mediaPartSummaryPrompt, mediaSummaryPrompt } from "../src/ephemeral-text-editor.js";
import { formatTimestamp, formatTimestampedTranscript, MEDIA_FORMAT_SELECTOR, parseCaptionTranscript,
  parseSupportedMediaUrl, selectCaptionTrack } from "../src/media-summary.js";

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

describe("efficient media input", () => {
  it("requests audio-only or the smallest practical video fallback", () => {
    expect(MEDIA_FORMAT_SELECTOR).toBe("bestaudio[abr<=96]/bestaudio/best[height<=144]/best[height<=240]/best");
    expect(MEDIA_FORMAT_SELECTOR).not.toContain("bestvideo");
  });

  it("uses a real manual caption track before automatic captions and ignores empty language entries", () => {
    expect(selectCaptionTrack({
      subtitles: {
        en: [],
        ru: [{ ext: "vtt", url: "https://example.test/manual" }],
      },
      automatic_captions: {
        "ru-orig": [{ ext: "json3", url: "https://example.test/auto" }],
      },
    })).toEqual({ language: "ru", automatic: false });
    expect(selectCaptionTrack({ subtitles: { ru: [] }, automatic_captions: { ru: [] } })).toBeUndefined();
  });

  it("converts JSON3 captions to timestamped text and collapses rolling duplicates", () => {
    const transcript = parseCaptionTranscript(JSON.stringify({ events: [
      { tStartMs: 1_200, segs: [{ utf8: "Первый" }] },
      { tStartMs: 2_000, segs: [{ utf8: "Первый тезис" }] },
      { tStartMs: 11_000, segs: [{ utf8: "Второй &amp; важный" }] },
    ] }), "json3");
    expect(transcript).toBe("[00:00:01] Первый тезис\n[00:00:11] Второй & важный");
  });

  it("converts WebVTT captions without cue metadata", () => {
    const transcript = parseCaptionTranscript([
      "WEBVTT",
      "",
      "00:00:03.000 --> 00:00:05.000 align:start position:0%",
      "<c>Текст первой реплики</c>",
      "",
      "2",
      "00:01:04.500 --> 00:01:07.000",
      "Вторая реплика",
    ].join("\n"), "vtt");
    expect(transcript).toBe("[00:00:03] Текст первой реплики\n[00:01:04] Вторая реплика");
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
