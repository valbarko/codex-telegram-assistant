import { describe, expect, it } from "vitest";

import { structureTranscript } from "../src/audio.js";

describe("structureTranscript", () => {
  it("adds origin, a compact summary and semantic emphasis", () => {
    const result = structureTranscript(
      "Валь, привет. Я нашла два готовых сервиса. Пока нужно поставить нашу разработку на паузу. Если они не подойдут, вернёмся к своему приложению.",
      { sender: "Анна", sentAt: Date.UTC(2026, 6, 12, 7, 41) },
    );

    expect(result).toContain("От: <b>Анна</b>");
    expect(result).toContain("12 июл. 2026 г., 10:41");
    expect(result).toContain("<b>Структурированная расшифровка</b>");
    expect(result).toContain("<b>Пока нужно поставить нашу разработку на паузу.</b>");
    expect(result).not.toContain("## Кратко");
    expect(result).not.toContain("## Структурированная");
  });

  it("escapes Telegram HTML", () => {
    expect(structureTranscript("Нужно выбрать A < B & C.")).toContain("A &lt; B &amp; C");
  });
});
