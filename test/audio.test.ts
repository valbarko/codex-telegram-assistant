import { describe, expect, it } from "vitest";

import { formatPlainTranscript, structureTranscript } from "../src/audio.js";

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

describe("formatPlainTranscript", () => {
  it("returns only polished prose split into balanced paragraphs", () => {
    const result = formatPlainTranscript(
      "арина,привет. я проверила первый вариант . там всё хорошо! завтра отправлю финальную версию",
    );

    expect(result).toBe([
      "Арина, привет. Я проверила первый вариант.",
      "Там всё хорошо! Завтра отправлю финальную версию.",
    ].join("\n\n"));
    expect(result).not.toMatch(/Структурированная расшифровка|Общая длительность|^\d+\s+голосов|<b>|\*\*/imu);
  });

  it("preserves existing paragraph boundaries", () => {
    expect(formatPlainTranscript("первый абзац\n\nвторой абзац")).toBe("Первый абзац.\n\nВторой абзац.");
  });
});
