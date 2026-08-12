import { describe, expect, it } from "vitest";

import {
  primarySourceLinks,
  selectTelegramRadarPosts,
  telegramRadarSourceId,
  type TelegramRadarPost,
} from "../src/telegram-topic-radar.js";

describe("Telegram content radar", () => {
  const now = Date.parse("2026-08-10T06:00:00+03:00");

  it("keeps fresh evidence-oriented posts and removes ads, stale posts, repeats and used sources", () => {
    const useful = post(1, -101, now - 60_000,
      "Новое исследование силовых тренировок и гипертрофии описывает выборку участников, результаты и ограничения. ".repeat(2),
      ["https://pubmed.ncbi.nlm.nih.gov/123/"]);
    const duplicate = post(2, -102, now - 120_000,
      `${useful.text} Незначительное дополнение автора канала.`);
    const nutrition = post(3, -103, now - 180_000,
      "Систематический обзор сравнил белок, аппетит и питание при снижении веса. Авторы обсуждают результаты и границы применимости. ".repeat(2));
    const advertisement = post(4, -104, now - 240_000,
      "Записывайтесь на курс по питанию: скидка и промокод, регистрация на вебинар уже открыта. ".repeat(3));
    const stale = post(5, -105, now - 72 * 3_600_000,
      "Исследование сна, восстановления и тренировок с большой выборкой участников. ".repeat(3));
    const irrelevant = post(6, -106, now - 300_000, "Сегодня автор гуляет по городу и делится личными новостями. ".repeat(3));

    const selected = selectTelegramRadarPosts([advertisement, stale, duplicate, nutrition, irrelevant, useful], {
      now,
      usedSourceIds: new Set([nutrition.sourceId]),
    });

    expect(selected.map((item) => item.sourceId)).toEqual([useful.sourceId]);
  });

  it("recognizes external evidence links and stable Telegram source identifiers", () => {
    expect(primarySourceLinks([
      "https://t.me/example/10",
      "https://pubmed.ncbi.nlm.nih.gov/123/",
      "https://tgstat.ru/channel/example",
    ])).toEqual(["https://pubmed.ncbi.nlm.nih.gov/123/"]);
    expect(telegramRadarSourceId({ chatId: -1001, messageId: 77 })).toBe("telegram:-1001:77");
  });
});

function post(
  messageId: number,
  chatId: number,
  publishedAt: number,
  text: string,
  links?: readonly string[],
): TelegramRadarPost {
  return {
    chatId,
    messageId,
    publishedAt,
    text,
    links,
    sourceId: telegramRadarSourceId({ chatId, messageId }),
    sourceKind: "telegram",
    sourceRole: "trend",
    sourceTitle: `Канал ${Math.abs(chatId)}`,
    channelTitle: `Канал ${Math.abs(chatId)}`,
    sourceUrl: `https://t.me/channel/${messageId}`,
  };
}
