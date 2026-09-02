import { describe, expect, it } from "vitest";

import { inferMediaLanguageHint, inferMediaTextLanguage, mediaLanguageMismatch,
  normalizeMediaLanguage, parseMediaLanguageHint } from "../src/media-language.js";
import { selectCaptionTrack } from "../src/media-summary.js";

const english = "Start working instead of waiting for the perfect conditions.";
const russian = "Начните работать, не дожидаясь идеальных условий для этого.";
const track = [{ url: "https://example.test/caption" }];

describe("media language hints", () => {
  it.each([["en-US", "en"], ["RU_ru", "ru"], ["en-orig", "en"], ["de", undefined], [null, undefined]])
    ("normalizes supported language codes: %s", (value, expected) => {
      expect(normalizeMediaLanguage(value)).toBe(expected);
    });

  it("prefers the selected audio track over localized video metadata and unrelated available tracks", () => {
    expect(inferMediaLanguageHint({ language: "ru", title: russian, description: russian,
      requested_formats: [{ acodec: "none", language: "ru" }, { acodec: "opus", language: "en-US" }],
      formats: [{ acodec: "opus", language: "ru" }] })).toEqual({ language: "en", source: "audio" });
    expect(inferMediaLanguageHint({ language: "en-US", title: russian }))
      .toEqual({ language: "en", source: "audio" });
  });

  it("reads nested download formats and does not guess over conflicting or unsupported audio languages", () => {
    expect(inferMediaLanguageHint({ requested_downloads: [{ language: "en",
      requested_formats: [{ acodec: "aac", language: "ru" }] }] }))
      .toEqual({ language: "ru", source: "audio" });
    expect(inferMediaLanguageHint({ requested_formats: [{ language: "ru" }, { language: "en" }], title: english }))
      .toBeUndefined();
    expect(inferMediaLanguageHint({ language: "de", title: english })).toBeUndefined();
  });

  it("uses consistent title and description as a weak hint without an AI request", () => {
    expect(inferMediaLanguageHint({ title: english })).toEqual({ language: "en", source: "text" });
    expect(inferMediaLanguageHint({ title: "90 дней", description: russian })).toEqual({ language: "ru", source: "text" });
    expect(inferMediaLanguageHint({ title: english, description: russian })).toBeUndefined();
    expect(inferMediaLanguageHint({ title: "#90", description: "https://example.com/long-english-url" })).toBeUndefined();
  });

  it("only flags clear RU/EN script conflicts, leaving short and mixed speech unrestricted", () => {
    expect(inferMediaTextLanguage("Да. OK.")).toBeUndefined();
    expect(inferMediaTextLanguage(`${russian} ${english}`)).toBeUndefined();
    expect(mediaLanguageMismatch(english, { language: "ru", source: "audio" })).toBe(true);
    expect(mediaLanguageMismatch(russian, { language: "ru", source: "audio" })).toBe(false);
    expect(mediaLanguageMismatch(`${english} ${russian}`, { language: "ru", source: "audio" })).toBe(false);
  });

  it("prefers matching original subtitles but permits available translations", () => {
    expect(selectCaptionTrack({ subtitles: { ru: track, en: track } }, { language: "en", source: "audio" }))
      .toEqual({ language: "en", automatic: false });
    expect(selectCaptionTrack({ subtitles: { ru: track }, automatic_captions: { en: track, "en-orig": track } },
      { language: "en", source: "audio" })).toEqual({ language: "en-orig", automatic: true });
    expect(selectCaptionTrack({ subtitles: { ru: track } }, { language: "en", source: "audio" }))
      .toEqual({ language: "ru", automatic: false });
  });

  it("validates persisted hints and tolerates legacy checkpoints", () => {
    expect(parseMediaLanguageHint('{"language":"en","source":"audio"}')).toEqual({ language: "en", source: "audio" });
    for (const value of [undefined, null, "invalid", '{"language":"en","source":"guess"}']) {
      expect(parseMediaLanguageHint(value)).toBeUndefined();
    }
  });
});
