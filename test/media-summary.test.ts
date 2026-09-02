import { describe, expect, it } from "vitest";

import { mediaPartSummaryPrompt, mediaSummaryPrompt, parseMediaSummaryResult } from "../src/ephemeral-text-editor.js";
import { fluidAudioArguments, parseFluidAudioTranscript } from "../src/fluid-audio.js";
import { assertUsableMediaTranscript, UnusableMediaTranscriptError } from "../src/media-transcript-quality.js";
import { classifyAssistantJobError } from "../src/assistant-job-worker.js";
import { formatTimestamp, formatTimestampedTranscript, MEDIA_FORMAT_SELECTOR, parseCaptionTranscript,
  parseSupportedMediaUrl, selectCaptionTrack, shouldUseFluidAudio } from "../src/media-summary.js";

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

describe("FluidAudio primary transcription", () => {
  it("pins Parakeet v3 without restricting the alphabet by default", () => {
    expect(fluidAudioArguments("/tmp/source.m4a", "/tmp/result.json")).toEqual([
      "transcribe", "/tmp/source.m4a", "--model-version", "v3", "--output-json", "/tmp/result.json",
    ]);
  });

  it.each(["ru", "en"])("only filters a language when explicitly requested: %s", (language) => {
    expect(fluidAudioArguments("/tmp/source.m4a", "/tmp/result.json", language)).toEqual([
      "transcribe", "/tmp/source.m4a", "--model-version", "v3", "--language", language, "--output-json", "/tmp/result.json",
    ]);
  });

  it("converts word timings into bounded timestamped segments", () => {
    const transcript = parseFluidAudioTranscript({
      text: "Первый тезис. Второй важный тезис.",
      wordTimings: [
        { word: "Первый", startTime: 1.2, endTime: 2, confidence: 0.9 },
        { word: "тезис.", startTime: 2, endTime: 5.3, confidence: 0.9 },
        { word: "Второй", startTime: 7, endTime: 8, confidence: 0.9 },
        { word: "важный", startTime: 8, endTime: 9, confidence: 0.9 },
        { word: "тезис.", startTime: 9, endTime: 12, confidence: 0.9 },
      ],
    });
    expect(formatTimestampedTranscript(transcript)).toBe([
      "[00:00:01] Первый тезис.",
      "[00:00:07] Второй важный тезис.",
    ].join("\n"));
  });

  it("uses the full text if FluidAudio supplies no valid word timings", () => {
    expect(formatTimestampedTranscript(parseFluidAudioTranscript({ text: "Готовый текст", wordTimings: [] })))
      .toBe("[00:00:00] Готовый текст");
  });

  it("keeps MLX Whisper selected after fallback chunks have been checkpointed", () => {
    expect(shouldUseFluidAudio([], [])).toBe(true);
    expect(shouldUseFluidAudio(["/tmp/chunk-0000.mka"], [])).toBe(false);
    expect(shouldUseFluidAudio([], ["[00:00:00] Уже готово"])).toBe(false);
  });
});

describe("media transcript quality", () => {
  it.each([
    "[00:00:00] Начните работать, не дожидаясь идеальных условий.",
    "[00:00:00] Start working instead of waiting for the perfect conditions.",
    "[00:00:00] Сегодня обсудим product market fit и следующий release.",
    "[00:00:00] Доход вырос на 10%: с 100000 до 110000 за 90 дней.",
    "[00:00:00] Да.\n[00:00:02] Нет.\n[00:00:04] Да.",
  ])("accepts readable prose, mixed languages, figures and short timestamped cues", (source) => {
    expect(() => assertUsableMediaTranscript(source)).not.toThrow();
  });

  it.each(["", "[00:00:00] 10-1, 10-0,-2, 13-20", "[00:00:00] '10, 10, 120, 2000-1%, 0.30 10-15-10, ст, 100, 200, 300, 400.'"])
    ("rejects the number/punctuation garbage reproduced on English audio", (source) => {
      expect(() => assertUsableMediaTranscript(source)).toThrow(UnusableMediaTranscriptError);
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
    expect(prompt).toContain("независимо от языка исходной речи");
    expect(prompt).toContain("status=unusable_source");
  });

  it("preserves facts and timestamps in intermediate summaries", () => {
    const prompt = mediaPartSummaryPrompt("[00:45:00] Тезис", 2, 4);
    expect(prompt).toContain("часть 2 из 4");
    expect(prompt).toContain("Сохраняй исходные таймкоды");
    expect(prompt).toContain("[00:45:00] Тезис");
  });

  it("accepts only a successful structured summary and fails closed on unusable source", () => {
    expect(parseMediaSummaryResult(JSON.stringify({ status: "ready", markdown: "# Готовый конспект" })))
      .toBe("# Готовый конспект");
    expect(() => parseMediaSummaryResult(JSON.stringify({ status: "unusable_source", markdown: "" })))
      .toThrow(UnusableMediaTranscriptError);
    expect(() => parseMediaSummaryResult(JSON.stringify({ status: "ready", markdown: " " }))).toThrow();
    expect(() => parseMediaSummaryResult("null")).toThrow();
    expect(() => parseMediaSummaryResult("# Невозможно восстановить содержание")).toThrow();
    expect(classifyAssistantJobError(new UnusableMediaTranscriptError()))
      .toMatchObject({ kind: "failed", errorClass: "transcript_quality" });
  });
});
