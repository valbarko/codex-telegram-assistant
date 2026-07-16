import { describe, expect, it } from "vitest";

import { publicTranscriptionErrorMessage, TELEGRAM_COPY_TEXT_LIMIT, transcriptionCopyPresentation } from "../src/telegram-copy.js";

describe("publicTranscriptionErrorMessage", () => {
  it("does not expose commands or tracebacks to Telegram users", () => {
    const message = publicTranscriptionErrorMessage(new Error("Command failed: python3 -c import mlx_whisper\nTraceback: secret path"));

    expect(message).toBe("Не удалось расшифровать голосовое. Попробуйте отправить его ещё раз.");
    expect(message).not.toMatch(/python|command failed|traceback|mlx_whisper/iu);
  });
});

describe("transcriptionCopyPresentation", () => {
  it("adds a native copy button to short transcripts", () => {
    const presentation = transcriptionCopyPresentation("Короткий текст.");

    expect(presentation).toMatchObject({ body: "Короткий текст." });
    expect(presentation.parseMode).toBeUndefined();
    expect(presentation.keyboard?.inline_keyboard).toEqual([[
      { text: "📋 Скопировать", copy_text: { text: "Короткий текст." } },
    ]]);
  });

  it("uses a copyable Telegram code block for long transcripts", () => {
    const text = `<мысль & продолжение> ${"а".repeat(TELEGRAM_COPY_TEXT_LIMIT)}`;
    const presentation = transcriptionCopyPresentation(text);

    expect(presentation.keyboard).toBeUndefined();
    expect(presentation.parseMode).toBe("HTML");
    expect(presentation.body).toBe(`<pre>&lt;мысль &amp; продолжение&gt; ${"а".repeat(TELEGRAM_COPY_TEXT_LIMIT)}</pre>`);
  });
});
