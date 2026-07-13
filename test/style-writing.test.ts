import { describe, expect, it } from "vitest";

import { rankCorpus, styleWritingPrompt } from "../src/style-writing.js";

describe("style writing", () => {
  it("builds a post prompt from the private style profile without borrowing facts", () => {
    const prompt = styleWritingPrompt("post", "Сегодня впервые провёл тренировку на улице", {
      profile: "Начинать с конкретной ситуации. Юмор строить на самоиронии.",
      examples: ["Однажды я опоздал на поезд и очень бодро побежал за ним."],
    });

    expect(prompt).toContain("Сегодня впервые провёл тренировку на улице");
    expect(prompt).toContain("Начинать с конкретной ситуации");
    expect(prompt).toContain("Однажды я опоздал");
    expect(prompt).toContain("Не придумывай опыт");
    expect(prompt).toContain("Не копируй из них факты");
    expect(prompt).toContain("Верни только готовый Telegram Markdown");
  });

  it("gives announcements and replies deliberately different scopes", () => {
    const context = { profile: "Живой голос.", examples: [] };
    expect(styleWritingPrompt("announcement", "В четверг встреча", context)).toContain("короткий анонс");
    expect(styleWritingPrompt("reply", "Можно ли новичку?", context)).toContain("одного-трёх небольших абзацев");
  });

  it("prefers topical rows in the lexical fallback", () => {
    const rows = [
      { source: "barko-pro-zhizn", text: "Сегодня море, путешествие и северное сияние", reactions: 2, weight: 1 },
      { source: "barko-pro-zhizn", text: "Первая тренировка в зале и разговор с тренером", reactions: 1, weight: 1 },
      { source: "v-svoem-tele", text: "Тренировка и мышцы", reactions: 100, weight: 1 },
    ];

    expect(rankCorpus(rows, "как прошла тренировка в зале", "barko-pro-zhizn", 1, "post")[0])
      .toContain("Первая тренировка");
  });
});
