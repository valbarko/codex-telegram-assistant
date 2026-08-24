import { describe, expect, it } from "vitest";

import { explicitTelegramPublicationMap, matchTelegramPublication } from "../src/telegram-publication-sync.js";

describe("Telegram publication identity", () => {
  const articles = [
    { slug: "known-article", title: "Совсем другой заголовок статьи" },
    { slug: "title-match", title: "Материал для сопоставления по заголовку" },
  ];

  it("prefers an explicit journal URL even when the visible title changed", () => {
    const journal = [
      JSON.stringify({
        event: "edited",
        channel: "telegram",
        article_slug: "known-article",
        url: "https://t.me/valbarko/42?single=1",
      }),
      "malformed legacy line",
    ].join("\n");

    const mapping = explicitTelegramPublicationMap(journal, articles);

    expect(mapping.get("https://t.me/valbarko/42")?.slug).toBe("known-article");
  });

  it("keeps title matching as a legacy fallback", () => {
    expect(matchTelegramPublication(
      articles,
      "Материал для сопоставления по заголовку — опубликованный текст",
    )?.slug).toBe("title-match");
  });
});
