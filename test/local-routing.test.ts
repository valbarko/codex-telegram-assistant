import { describe, expect, it } from "vitest";

import { quietCodexPrompt } from "../src/prompt-policy.js";
import { localIntent } from "../src/telegram-app.js";

describe("local Telegram routing", () => {
  it("keeps alarms and calendar actions out of Codex", () => {
    expect(localIntent("поставь будильник на 14:00")).toBe("reminder");
    expect(localIntent("создай событие сегодня, 18:00")).toBe("calendar-create");
    expect(localIntent("покажи ближайшие события календаря")).toBe("calendar-list");
  });

  it("leaves unrelated work for Codex", () => expect(localIntent("проверь git status проекта")).toBeNull());
});

describe("quiet Codex policy", () => {
  it("suppresses internal implementation narration", () => {
    const prompt = quietCodexPrompt("проверь проект");
    expect(prompt).toContain("Не описывай внутренние skills, MCP, RTK, PATH");
    expect(prompt).toContain("проверь проект");
  });
});
