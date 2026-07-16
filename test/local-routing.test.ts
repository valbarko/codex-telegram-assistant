import { describe, expect, it } from "vitest";

import { localCommandFallbackPrompt, quietCodexPrompt } from "../src/prompt-policy.js";
import { localIntent } from "../src/telegram-app.js";

describe("local Telegram routing", () => {
  it("keeps alarms and calendar actions out of Codex", () => {
    expect(localIntent("поставь будильник на 14:00")).toBe("reminder");
    expect(localIntent("создай событие сегодня, 18:00")).toBe("calendar-create");
    expect(localIntent("создай задачу в календаре на сегодня 18:00 стоматолог")).toBe("calendar-create");
    expect(localIntent("покажи ближайшие события календаря")).toBe("calendar-list");
  });

  it("leaves unrelated work for Codex", () => expect(localIntent("проверь git status проекта")).toBeNull());
});

describe("quiet Codex policy", () => {
  it("suppresses internal implementation narration", () => {
    const prompt = quietCodexPrompt("проверь проект");
    expect(prompt).toContain("Не описывай внутренние skills, MCP, RTK, PATH");
    expect(prompt).toContain("Пиши по-русски в стиле Валентина");
    expect(prompt).toContain("не придумывай личный опыт");
    expect(prompt).toContain("проверь проект");
  });

  it("asks Codex to clarify an unparsed local command without acting", () => {
    const prompt = localCommandFallbackPrompt("создай встречу когда освобожусь");
    expect(prompt).toContain("не смог надёжно извлечь все параметры");
    expect(prompt).toContain("Не выполняй внешних действий");
    expect(prompt).toContain("задай один короткий уточняющий вопрос");
    expect(prompt).toContain("создай встречу когда освобожусь");
  });
});
