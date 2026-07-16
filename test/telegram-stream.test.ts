import { afterEach, describe, expect, it, vi } from "vitest";

import { TelegramTurnView } from "../src/telegram-app.js";

describe("TelegramTurnView", () => {
  afterEach(() => vi.useRealTimers());

  it("serializes overlapping stream updates into one Telegram message", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstReply = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const reply = vi.fn(async () => {
      await firstReply;
      return { message_id: 42 };
    });
    const editMessageText = vi.fn(async () => true);
    const ctx = { chat: { id: 7 }, reply, api: { editMessageText } };
    const view = new TelegramTurnView(ctx as never, async () => "decline", async () => ({}), false);

    view.text("Разрешение получено. ");
    await vi.advanceTimersByTimeAsync(0);
    expect(reply).toHaveBeenCalledTimes(1);

    view.text("Повторно подключаюсь.");
    await vi.advanceTimersByTimeAsync(1000);
    const finished = view.finish();
    releaseFirst();
    await finished;

    expect(reply).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenLastCalledWith(7, 42, "Разрешение получено. Повторно подключаюсь.", { parse_mode: "HTML" });
  });

  it("renders Codex Markdown as Telegram HTML", async () => {
    const reply = vi.fn(async () => ({ message_id: 9 }));
    const ctx = { chat: { id: 7 }, reply, api: { editMessageText: vi.fn(async () => true) } };
    const view = new TelegramTurnView(ctx as never, async () => "decline", async () => ({}), false);
    view.text("1. **Важный итог**: запустите `rsync`.");
    await view.finish();
    expect(reply).toHaveBeenCalledWith("1. <b>Важный итог</b>: запустите <code>rsync</code>.", { parse_mode: "HTML" });
  });

  it("does not rewrite an already formatted final answer as raw Markdown", async () => {
    vi.useFakeTimers();
    const reply = vi.fn(async () => ({ message_id: 9 }));
    const editMessageText = vi.fn(async () => true);
    const ctx = { chat: { id: 7 }, reply, api: { editMessageText } };
    const view = new TelegramTurnView(ctx as never, async () => "decline", async () => ({}), false);

    view.text("Сегодня **+20…+23 °C**. [Источник](https://example.com/)");
    await vi.advanceTimersByTimeAsync(0);
    await view.finish();

    expect(reply).toHaveBeenCalledWith(
      "Сегодня <b>+20…+23 °C</b>. <a href=\"https://example.com/\">Источник</a>",
      { parse_mode: "HTML" },
    );
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it("replaces the streamed draft with the final editorial result", async () => {
    vi.useFakeTimers();
    const reply = vi.fn(async () => ({ message_id: 9 }));
    const editMessageText = vi.fn(async () => true);
    const ctx = { chat: { id: 7 }, reply, api: { editMessageText } };
    const view = new TelegramTurnView(ctx as never, async () => "decline", async () => ({}), false);

    view.text("сырой ответ");
    await vi.advanceTimersByTimeAsync(0);
    await view.finish("**Готовый ответ**");

    expect(reply).toHaveBeenCalledWith("сырой ответ", { parse_mode: "HTML" });
    expect(editMessageText).toHaveBeenLastCalledWith(7, 9, "<b>Готовый ответ</b>", { parse_mode: "HTML" });
  });

  it("keeps an unedited draft hidden until the final editorial pass", async () => {
    const reply = vi.fn(async () => ({ message_id: 9 }));
    const editMessageText = vi.fn(async () => true);
    const ctx = { chat: { id: 7 }, reply, api: { editMessageText } };
    const view = new TelegramTurnView(ctx as never, async () => "decline", async () => ({}), false, false);

    await view.start();
    view.text("сырой внутренний черновик");
    expect(editMessageText).not.toHaveBeenCalled();

    await view.finish("**Финальный ответ**");

    expect(reply).toHaveBeenCalledWith("✍️ Привожу ответ в порядок…");
    expect(editMessageText).toHaveBeenCalledOnce();
    expect(editMessageText).toHaveBeenCalledWith(7, 9, "<b>Финальный ответ</b>", { parse_mode: "HTML" });
  });

  it("never exposes a system exception in a failed streamed answer", async () => {
    const reply = vi.fn(async () => ({ message_id: 9 }));
    const ctx = { chat: { id: 7 }, reply, api: { editMessageText: vi.fn(async () => true) } };
    const view = new TelegramTurnView(ctx as never, async () => "decline", async () => ({}), false);

    await view.fail();

    expect(reply).toHaveBeenCalledWith("Не удалось выполнить запрос. Попробуйте ещё раз.", { parse_mode: "HTML" });
  });
});
