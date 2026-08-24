import { describe, expect, it, vi } from "vitest";

import { syncContentAnalytics, syncMetrikaAnalytics, syncSearchAnalytics } from "../src/content-analytics-sync.js";

describe("content analytics sync", () => {
  it("runs the bank collector without passing credentials in arguments", async () => {
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify({
        telegram: { status: "ok", records: 3 },
        instagram: { status: "ok", records: 2 },
      }),
      stderr: "",
    }));

    const result = await syncContentAnalytics("/tmp/article-bank", execute as never);

    expect(result.telegram?.records).toBe(3);
    expect(execute).toHaveBeenCalledWith(
      "python3",
      ["/tmp/article-bank/scripts/sync_social_analytics.py"],
      expect.objectContaining({ cwd: "/tmp/article-bank", timeout: 90_000 }),
    );
    expect(execute).toHaveBeenCalledWith(
      "python3",
      ["/tmp/article-bank/scripts/article_bank.py", "render"],
      expect.objectContaining({ cwd: "/tmp/article-bank", timeout: 90_000 }),
    );
  });

  it("rejects malformed collector output", async () => {
    const execute = vi.fn(async () => ({ stdout: "not-json", stderr: "" }));
    await expect(syncContentAnalytics("/tmp/article-bank", execute as never)).rejects.toThrow();
  });

  it("runs the daily search collector without passing OAuth credentials", async () => {
    const execute = vi.fn(async (_executable, args: string[]) => ({
      stdout: args.at(-1) === "render"
        ? "Обновлён каталог"
        : JSON.stringify({ status: "ok", records: 469, projects: {} }),
      stderr: "",
    }));

    const result = await syncSearchAnalytics("/tmp/article-bank", execute as never);

    expect(result.records).toBe(469);
    expect(execute).toHaveBeenCalledWith(
      "python3",
      ["/tmp/article-bank/scripts/sync_search_analytics.py"],
      expect.objectContaining({ cwd: "/tmp/article-bank", timeout: 180_000 }),
    );
  });

  it("runs the daily Metrika collector through the protected aggregate proxy", async () => {
    const execute = vi.fn(async (_executable, args: string[]) => ({
      stdout: args.at(-1) === "render"
        ? "Обновлён каталог"
        : JSON.stringify({ status: "ok", records: 12, projects: {} }),
      stderr: "",
    }));

    const result = await syncMetrikaAnalytics("/tmp/article-bank", execute as never);

    expect(result.records).toBe(12);
    expect(execute).toHaveBeenCalledWith(
      "python3",
      ["/tmp/article-bank/scripts/sync_metrika_analytics.py"],
      expect.objectContaining({ cwd: "/tmp/article-bank", timeout: 180_000 }),
    );
  });
});
