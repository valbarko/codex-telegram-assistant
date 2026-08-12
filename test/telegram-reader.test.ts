import { describe, expect, it } from "vitest";

import {
  detectTelegramPostMediaKind,
  extractTelegramChannelMessage,
  filterTelegramChannels,
  selectTelegramChannels,
  validateTelegramScheduleTime,
} from "../src/telegram-reader.js";
import { validateTelegramReaderCredentials } from "../src/telegram-reader-keychain.js";
import { matchTelegramPublication, normalizeForMatch } from "../src/telegram-publication-sync.js";

describe("Telegram channel reader", () => {
  const channels = [
    { id: -1001, title: "Канал Б", type: { _: "chatTypeSupergroup", is_channel: true }, usernames: { active_usernames: ["b"] } },
    { id: 42, title: "Личный чат", type: { _: "chatTypePrivate" } },
    { id: -1002, title: "Группа", type: { _: "chatTypeSupergroup", is_channel: false } },
    { id: -1003, title: "Канал А", type: { _: "chatTypeSupergroup", is_channel: true } },
  ];

  it("exposes only broadcast channels and never private chats or groups", () => {
    expect(filterTelegramChannels(channels)).toEqual([
      { chatId: -1003, title: "Канал А", username: undefined },
      { chatId: -1001, title: "Канал Б", username: "b" },
    ]);
  });

  it("requires an explicit valid channel selection", () => {
    const filtered = filterTelegramChannels(channels);
    expect(selectTelegramChannels(filtered, "2, 1, 2")).toEqual([filtered[1], filtered[0]]);
    expect(() => selectTelegramChannels(filtered, "")).toThrow(/Choose channel numbers/u);
    expect(() => selectTelegramChannels(filtered, "3")).toThrow(/Choose channel numbers/u);
  });

  it("extracts text and captions without downloading media", () => {
    expect(extractTelegramChannelMessage({
      id: 77, chat_id: -1003, date: 1_700_000_000,
      content: { _: "messagePhoto", caption: { text: "  Подпись\nк фото  " } },
    })).toEqual({ chatId: -1003, messageId: 77, publishedAt: 1_700_000_000_000, text: "Подпись к фото" });
    expect(extractTelegramChannelMessage({
      id: 78, chat_id: -1003, date: 1_700_000_001, content: { _: "messageSticker" },
    })).toBeUndefined();
    expect(extractTelegramChannelMessage({
      id: 79, chat_id: -1003, date: 1_700_000_002,
      content: {
        _: "messageText",
        text: {
          text: "Исследование и https://example.org/paper",
          entities: [{ offset: 0, length: 12, type: { _: "textEntityTypeTextUrl", url: "https://doi.org/10.1/test" } }],
        },
      },
      interaction_info: { view_count: 500, forward_count: 12 },
    })).toMatchObject({
      links: ["https://doi.org/10.1/test", "https://example.org/paper"], views: 500, forwards: 12,
    });
  });

  it("validates API credentials before creating a Telegram session", () => {
    expect(validateTelegramReaderCredentials({
      apiId: 123, apiHash: "a".repeat(32), databaseEncryptionKey: Buffer.alloc(32, 1).toString("base64"),
    }).apiId).toBe(123);
    expect(() => validateTelegramReaderCredentials({
      apiId: 0, apiHash: "bad", databaseEncryptionKey: "bad",
    })).toThrow(/API ID/u);
  });

  it("detects native Telegram media types and falls back to a document", () => {
    expect(detectTelegramPostMediaKind("cover.JPEG")).toBe("photo");
    expect(detectTelegramPostMediaKind("clip.mp4")).toBe("video");
    expect(detectTelegramPostMediaKind("research.pdf")).toBe("document");
  });

  it("accepts only future Telegram schedule times within 367 days", () => {
    const now = Date.parse("2026-08-11T18:00:00+03:00");
    expect(validateTelegramScheduleTime(now + 60_000, now)).toBe(now + 60_000);
    expect(validateTelegramScheduleTime(undefined, now)).toBeUndefined();
    expect(() => validateTelegramScheduleTime(now, now)).toThrow(/future/u);
    expect(() => validateTelegramScheduleTime(now + 368 * 24 * 60 * 60_000, now)).toThrow(/367 days/u);
  });

  it("matches article titles in Telegram captions despite case and punctuation", () => {
    const articles = [
      { slug: "short", title: "Омлет вместо идеальной тренировки" },
      { slug: "long", title: "1800 тренировок спустя: очередная глава жизни закончилась" },
    ];
    expect(matchTelegramPublication(articles, "1800 ТРЕНИРОВОК СПУСТЯ — очередная глава жизни закончилась\n\nТекст поста"))
      .toEqual(articles[1]);
    expect(matchTelegramPublication(articles, "Совсем другой пост")).toBeUndefined();
    expect(normalizeForMatch("В СВОЁМ  ТЕЛЕ! ")).toBe("в своем теле");
  });
});
