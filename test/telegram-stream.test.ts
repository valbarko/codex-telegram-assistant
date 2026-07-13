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
});
