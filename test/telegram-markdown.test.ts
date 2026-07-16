import { describe, expect, it, vi } from "vitest";

import {
  markdownTelegramTransformer,
  markdownToPlainText,
  markdownToTelegramHtml,
  sendTelegramMarkdown,
  telegramMarkdownChunks,
  truncateTelegramHtml,
} from "../src/telegram-markdown.js";

describe("Telegram Markdown", () => {
  it("renders headings, emphasis, code, quotes and fenced code as Telegram HTML", () => {
    const markdown = "## 12 июля\n\nОбычный текст, **важная мысль** и `rsync`.\n\n> Цитата\n\n```js\nconst a = 1 < 2;\n```";
    const html = markdownToTelegramHtml(markdown);

    expect(html).toContain("<b>12 июля</b>");
    expect(html).toContain("<b>важная мысль</b>");
    expect(html).toContain("<code>rsync</code>");
    expect(html).toContain("<blockquote>Цитата</blockquote>");
    expect(html).toContain("<pre><code class=\"language-js\">const a = 1 &lt; 2;</code></pre>");
  });

  it("truncates Telegram HTML without leaving tags or entities open", () => {
    const result = truncateTelegramHtml(`<b>${"важно &amp; ".repeat(100)}</b>`, 120);

    expect(result.length).toBeLessThanOrEqual(120);
    expect(result).toMatch(/^<b>.*<\/b>$/);
    expect(result).not.toMatch(/&[^;]*<\/b>$/);
  });

  it("sends every generated text as formatted HTML", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});

    await sendTelegramMarkdown({ sendMessage }, "owner", "## Главное\n\n**Готово** и `rsync`.");

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      "owner",
      "<b>Главное</b>\n\n<b>Готово</b> и <code>rsync</code>.",
      { parse_mode: "HTML" },
    );
  });

  it("falls back to clean plain text when Telegram rejects formatted HTML", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("bad html"))
      .mockResolvedValueOnce({});

    await sendTelegramMarkdown({ sendMessage }, "owner", "**важно**");

    expect(sendMessage).toHaveBeenNthCalledWith(1, "owner", "<b>важно</b>", { parse_mode: "HTML" });
    expect(sendMessage).toHaveBeenNthCalledWith(2, "owner", "важно");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("splits long Markdown into Telegram-safe chunks", () => {
    const chunks = telegramMarkdownChunks(Array.from({ length: 40 }, (_, index) => `**Абзац ${index}** ${"текст ".repeat(15)}`).join("\n\n"), 500);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.html.length <= 500)).toBe(true);
    expect(chunks.every((chunk) => !chunk.html.includes("**"))).toBe(true);
  });

  it("turns every plain Telegram message into formatted HTML at the API boundary", async () => {
    const prev = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });
    const transform = markdownTelegramTransformer as any;

    await transform(prev, "sendMessage", {
      chat_id: 7,
      text: "Сегодня **+20…+23 °C**. [Источник](https://example.com/)",
    });

    expect(prev).toHaveBeenCalledWith("sendMessage", {
      chat_id: 7,
      text: "Сегодня <b>+20…+23 °C</b>. <a href=\"https://example.com/\">Источник</a>",
      parse_mode: "HTML",
    }, undefined);
  });

  it("treats an identical final edit as success without replacing HTML with raw Markdown", async () => {
    const prev = vi.fn().mockResolvedValue({
      ok: false, error_code: 400, description: "Bad Request: message is not modified",
    });
    const transform = markdownTelegramTransformer as any;

    const result = await transform(prev, "editMessageText", { chat_id: 7, message_id: 9, text: "**Готово**" });

    expect(result).toEqual({ ok: true, result: true });
    expect(prev).toHaveBeenCalledOnce();
  });

  it("removes Markdown markers from the last-resort plain-text fallback", () => {
    expect(markdownToPlainText("## Главное\n\n**Готово** · [Источник](https://example.com/) · `код`"))
      .toBe("Главное\n\nГотово · Источник · код");
  });
});
