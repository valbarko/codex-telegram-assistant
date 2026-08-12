import { describe, expect, it } from "vitest";

import { articleIdeaPrompt, fallbackArticleIdeaDraft, isArticleIdeaRequest,
  normalizeArticleIdeaDraft } from "../src/article-idea.js";

describe("article idea capture", () => {
  it("recognizes the two natural phrases used with the assistant", () => {
    expect(isArticleIdeaRequest("Ещё одну статью в банк статей придумал: почему отдыхать нужно скучно")).toBe(true);
    expect(isArticleIdeaRequest("Хорошая мысль для поста: попытка не гарантирует успех")).toBe(true);
    expect(isArticleIdeaRequest("Проверь, попала ли мысль для поста в банк статей")).toBe(false);
  });

  it("normalizes a structured draft and rejects unknown categories", () => {
    const draft = normalizeArticleIdeaDraft(JSON.stringify({
      title: "Почему отдыхать нужно скучно",
      summary: "Личная заметка о восстановлении без новых задач.",
      category: "travel",
      tags: ["отпуск", "восстановление"],
      articleMarkdown: "# Почему отдыхать нужно скучно\n\nИногда отпуск нужен не для впечатлений.",
      telegramMarkdown: "# Почему отдыхать нужно скучно\n\nЯ выбрал знакомое место.",
      vcMarkdown: "# Почему отдыхать нужно скучно\n\nПредсказуемый отпуск тоже может быть полезным.",
    }));
    expect(draft.category).toBe("travel");
    expect(draft.tags).toEqual(["отпуск", "восстановление"]);
    expect(draft.articleMarkdown).toBe("Иногда отпуск нужен не для впечатлений.");
    expect(() => normalizeArticleIdeaDraft(JSON.stringify({ ...draft, category: "unknown" })))
      .toThrow("Неизвестная рубрика");
  });

  it("keeps the author core out of the generated-output contract", () => {
    const prompt = articleIdeaPrompt("Моя короткая мысль", {
      profile: "Пиши конкретно.",
      examples: ["Первый пример", "Второй пример", "Третий пример"],
    });
    expect(prompt).toContain("Исходная мысль будет сохранена системой отдельно и дословно");
    expect(prompt).toContain("ПРИМЕР 3");
    expect(prompt).not.toContain("ПРИМЕР 4");
  });

  it("creates a safe fallback without pretending an expansion succeeded", () => {
    const draft = fallbackArticleIdeaDraft("Хорошая мысль для поста: попробовать новое, даже если страшно");
    expect(draft.title).toContain("Попробовать новое");
    expect(draft.articleMarkdown).toBe("");
    expect(draft.telegramMarkdown).toBe("");
  });
});
