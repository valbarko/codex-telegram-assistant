import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readConfiguration } from "../src/configuration.js";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe("readConfiguration", () => {
  it("loads private defaults without depending on a machine username", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "cta-config-")); folders.push(cwd);
    const config = readConfiguration(cwd, { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "12,34", HOME: "/home/person" });
    expect(config.allowedUsers).toEqual(new Set([12, 34]));
    expect(config.transcriptionOnlyUsers).toEqual(new Set());
    expect(config.dataDirectory).toBe("/home/person/.local/share/codex-telegram-assistant");
    expect(config.memsearchExecutable).toBe("/home/person/.local/bin/memsearch");
    expect(config).toMatchObject({
      appleNotesImportEnabled: false, appleNotesImportIntervalMs: 86_400_000,
      appleNotesImportProtected: false,
      hindsightEnabled: false, hindsightBaseUrl: "http://127.0.0.1:8888",
      hindsightReflectBudget: "low", hindsightTimeoutMs: 45_000,
      hindsightLiveBatchSize: 10, hindsightLiveFlushMs: 5_000,
    });
    expect(config.profiles.map((profile) => profile.id)).toEqual(["default", "review", "readonly"]);
    expect(config).toMatchObject({ weatherLocation: "Москва", weatherLatitude: 55.7558, weatherLongitude: 37.6173 });
    expect(config).toMatchObject({
      mediaDownloaderExecutable: "yt-dlp", ffmpegExecutable: "ffmpeg", mediaSummaryMaxDurationSeconds: 21_600,
    });
  });

  it("loads a configurable weather location", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "cta-config-")); folders.push(cwd);
    const config = readConfiguration(cwd, {
      TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "12", WEATHER_LOCATION: "Сочи",
      WEATHER_LATITUDE: "43.5855", WEATHER_LONGITUDE: "39.7231",
    });
    expect(config).toMatchObject({ weatherLocation: "Сочи", weatherLatitude: 43.5855, weatherLongitude: 39.7231 });
  });

  it("loads media summary executables and duration limit", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "cta-config-")); folders.push(cwd);
    const config = readConfiguration(cwd, {
      TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "12",
      MEDIA_DOWNLOADER_BIN: "/opt/bin/yt-dlp", FFMPEG_BIN: "/opt/bin/ffmpeg",
      MEDIA_SUMMARY_MAX_DURATION_SECONDS: "10800", MEDIA_COOKIES_FROM_BROWSER: "chrome:Profile 1",
    });
    expect(config).toMatchObject({
      mediaDownloaderExecutable: "/opt/bin/yt-dlp", ffmpegExecutable: "/opt/bin/ffmpeg",
      mediaSummaryMaxDurationSeconds: 10_800, mediaCookiesFromBrowser: "chrome:Profile 1",
    });
  });

  it("loads the dedicated Whisper runtime from dotenv values", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "cta-config-")); folders.push(cwd);
    const config = readConfiguration(cwd, {
      TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "12",
      WHISPER_PYTHON: "/opt/whisper/bin/python", WHISPER_MODEL: "local/whisper-model",
    });

    expect(config).toMatchObject({ whisperPython: "/opt/whisper/bin/python", whisperModel: "local/whisper-model" });
  });

  it("loads the optional Hindsight knowledge layer", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "cta-config-")); folders.push(cwd);
    const config = readConfiguration(cwd, {
      TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "12",
      HINDSIGHT_ENABLED: "true", HINDSIGHT_BASE_URL: "http://localhost:9000/",
      HINDSIGHT_API_KEY: "local-key", HINDSIGHT_REFLECT_BUDGET: "mid", HINDSIGHT_TIMEOUT_MS: "90000",
      HINDSIGHT_LIVE_BATCH_SIZE: "7", HINDSIGHT_LIVE_FLUSH_MS: "12000",
    });

    expect(config).toMatchObject({
      hindsightEnabled: true, hindsightBaseUrl: "http://localhost:9000",
      hindsightApiKey: "local-key", hindsightReflectBudget: "mid", hindsightTimeoutMs: 90_000,
      hindsightLiveBatchSize: 7, hindsightLiveFlushMs: 12_000,
    });
  });

  it("loads Apple Notes import and infers its single full-access owner", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "cta-config-")); folders.push(cwd);
    const config = readConfiguration(cwd, {
      TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "12",
      APPLE_NOTES_IMPORT_ENABLED: "true", APPLE_NOTES_IMPORT_INTERVAL_MS: "3600000",
      APPLE_NOTES_IMPORT_PROTECTED: "true",
    });

    expect(config).toMatchObject({
      appleNotesImportEnabled: true,
      appleNotesImportOwner: "12",
      appleNotesImportIntervalMs: 3_600_000,
      appleNotesImportProtected: true,
    });
  });

  it("requires an explicit Apple Notes owner when multiple full-access users exist", () => {
    expect(() => readConfiguration("/tmp", {
      TELEGRAM_BOT_TOKEN: "x", TELEGRAM_ALLOWED_USER_IDS: "12,34",
      APPLE_NOTES_IMPORT_ENABLED: "true",
    })).toThrow("APPLE_NOTES_IMPORT_OWNER_ID");
  });

  it("rejects two media cookie sources", () => {
    expect(() => readConfiguration("/tmp", {
      TELEGRAM_BOT_TOKEN: "x", TELEGRAM_ALLOWED_USER_IDS: "12",
      MEDIA_COOKIES_FROM_BROWSER: "chrome", MEDIA_COOKIES_FILE: "/tmp/cookies.txt",
    })).toThrow("Set only one");
  });

  it("loads isolated transcription-only users", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "cta-config-")); folders.push(cwd);
    const config = readConfiguration(cwd, {
      TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "12",
      TELEGRAM_TRANSCRIPTION_ONLY_USER_IDS: "42, 43",
    });
    expect(config.allowedUsers).toEqual(new Set([12]));
    expect(config.transcriptionOnlyUsers).toEqual(new Set([42, 43]));
  });

  it("rejects overlapping full and transcription-only access", () => {
    expect(() => readConfiguration("/tmp", {
      TELEGRAM_BOT_TOKEN: "x", TELEGRAM_ALLOWED_USER_IDS: "12",
      TELEGRAM_TRANSCRIPTION_ONLY_USER_IDS: "12",
    })).toThrow("cannot have both full and transcription-only access");
  });

  it("rejects missing secrets and unknown profiles", () => {
    expect(() => readConfiguration("/tmp", {})).toThrow("TELEGRAM_BOT_TOKEN");
    expect(() => readConfiguration("/tmp", { TELEGRAM_BOT_TOKEN: "x", TELEGRAM_ALLOWED_USER_IDS: "1", ASSISTANT_DEFAULT_PROFILE: "missing" })).toThrow("Unknown ASSISTANT_DEFAULT_PROFILE");
    expect(() => readConfiguration("/tmp", {
      TELEGRAM_BOT_TOKEN: "x", TELEGRAM_ALLOWED_USER_IDS: "1", HINDSIGHT_REFLECT_BUDGET: "huge",
    })).toThrow("HINDSIGHT_REFLECT_BUDGET");
  });
});
