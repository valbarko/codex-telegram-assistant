import { describe, expect, it } from "vitest";

import { localCommandFallbackPrompt, quietCodexPrompt } from "../src/prompt-policy.js";
import { contentArtifactArticlePrompt, isContextualArticleBankRequest, localIntent } from "../src/telegram-app.js";

describe("local Telegram routing", () => {
  it("keeps alarms and calendar actions out of Codex", () => {
    expect(localIntent("поставь будильник на 14:00")).toBe("reminder");
    expect(localIntent("создай событие сегодня, 18:00")).toBe("calendar-create");
    expect(localIntent("создай задачу в календаре на сегодня 18:00 стоматолог")).toBe("calendar-create");
    expect(localIntent("покажи ближайшие события календаря")).toBe("calendar-list");
    expect(localIntent("давай перейдем в кодекс")).toBe("codex-open");
    expect(localIntent("продолжим этот чат в Codex")).toBe("codex-open");
  });

  it("leaves unrelated work for Codex", () => expect(localIntent("проверь git status проекта")).toBeNull());

  it("resolves only short contextual article-bank commands through a concrete artifact", () => {
    expect(isContextualArticleBankRequest("добавь это в банк статей")).toBe(true);
    expect(isContextualArticleBankRequest("сохрани пост в Банке статей")).toBe(true);
    expect(isContextualArticleBankRequest("добавь в банк статей", true)).toBe(true);
    expect(isContextualArticleBankRequest("добавь в банк статей статью о восстановлении после тренировок")).toBe(false);
    expect(isContextualArticleBankRequest("проверь, есть ли это в банке статей")).toBe(false);
  });

  it("makes an artifact delivery prompt self-contained", () => {
    const prompt = contentArtifactArticlePrompt({ id: "artifact-1", kind: "post", body: "Точный текст", bodyHash: "abc" });
    expect(prompt).toContain("Идентификатор материала: artifact-1");
    expect(prompt).toContain("SHA-256 материала: abc");
    expect(prompt).toContain("--- НАЧАЛО МАТЕРИАЛА ---\nТочный текст\n--- КОНЕЦ МАТЕРИАЛА ---");
    expect(prompt).toContain("Не подменяй его содержанием предыдущих сообщений");
  });
});

describe("quiet Codex policy", () => {
  it("suppresses internal implementation narration", () => {
    const prompt = quietCodexPrompt("проверь проект");
    expect(prompt).toContain("Не описывай внутренние инструменты");
    expect(prompt).toContain("Ответь по-русски");
    expect(prompt).toContain("Не выдумывай факты, личный опыт или эмоции");
    expect(prompt).toContain("проверь проект");
    expect(prompt.length - "проверь проект".length).toBeLessThan(350);
  });

  it("asks Codex to clarify an unparsed local command without acting", () => {
    const prompt = localCommandFallbackPrompt("создай встречу когда освобожусь");
    expect(prompt).toContain("не смог надёжно извлечь все параметры");
    expect(prompt).toContain("Не выполняй внешних действий");
    expect(prompt).toContain("задай один короткий уточняющий вопрос");
    expect(prompt).toContain("создай встречу когда освобожусь");
  });
});
