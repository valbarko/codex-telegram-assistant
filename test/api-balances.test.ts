import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readApiBalances, summarizeApiBalances } from "../src/api-balances.js";
import { morningDigestText } from "../src/scheduler.js";

const now = Date.parse("2026-09-14T06:00:00+03:00");
const checkedAt = "2026-09-14T05:52:00+03:00";
const snapshot = (google = 390, openai = 0.5) => ({ version: 1, providers: {
  google: { status: "ok", amount: google, currency: "TRY", checkedAt },
  openai: { status: "ok", amount: openai, currency: "USD", checkedAt },
} });

describe("morning API balances", () => {
  it("shows credit balances and puts low balances in today's actions", () => {
    const balances = summarizeApiBalances(snapshot(), now);
    const text = morningDigestText({ weather: "Погода", calendar: [], groups: [], inbox: 0, tasks: [], balances, now });
    expect(text).toContain("**💳 Балансы API**");
    expect(text).toContain("Google Gemini: 390,00 ₺");
    expect(text).toContain("OpenAI API: 0,50 $");
    expect(text).toContain("**пора пополнить** · 05:52 МСК");
    expect(text.split("**Что стоит сделать сегодня**")[1]).toContain("Пополнить OpenAI API");
    expect(balances.recommendations).toHaveLength(1);
  });

  it("warns at the threshold, at zero, and after overspending", () => {
    expect(summarizeApiBalances(snapshot(100, 5), now).recommendations).toHaveLength(2);
    expect(summarizeApiBalances(snapshot(0, -0.5), now).recommendations).toHaveLength(2);
    expect(summarizeApiBalances(snapshot(100.01, 5.01), now).recommendations).toHaveLength(0);
  });

  it("never presents old, future or previous-day values as current", () => {
    for (const stamp of ["2026-09-14T03:59:00+03:00", "2026-09-14T06:01:00+03:00", "invalid"]) {
      const value = snapshot();
      value.providers.google.checkedAt = stamp;
      const result = summarizeApiBalances(value, now);
      expect(result.lines[0]).toContain("нет свежих данных");
      expect(result.lines[0]).not.toContain("390,00");
      expect(result.recommendations).toHaveLength(1);
    }
    const value = snapshot();
    value.providers.google.checkedAt = "2026-09-13T23:50:00+03:00";
    expect(summarizeApiBalances(value, Date.parse("2026-09-14T00:10:00+03:00")).lines[0]).toContain("нет свежих данных");
  });

  it("does not turn access failures or malformed data into a zero balance", () => {
    const result = summarizeApiBalances({ version: 1, providers: {
      google: { status: "unavailable", reason: "login_required", checkedAt },
      openai: { status: "ok", amount: "$100 [injected](https://example.com)", currency: "USD", checkedAt },
    } }, now);
    expect(result.lines[0]).toContain("нужно войти в кабинет");
    expect(result.lines[1]).toContain("не удалось проверить");
    expect(result.lines.join(" ")).not.toMatch(/example.com|0,00|injected/);
    expect(result.recommendations).toEqual([]);
    const wrongCurrency = snapshot();
    wrongCurrency.providers.google.currency = "USD";
    expect(summarizeApiBalances(wrongCurrency, now).lines[0]).toContain("не удалось проверить");
    expect(summarizeApiBalances({ ...snapshot(), version: 2 }, now).lines.join(" ")).not.toContain("390,00");
  });

  it("keeps missing or damaged files non-blocking", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cta-balances-"));
    try {
      const file = path.join(directory, "balances.json");
      expect(await readApiBalances(undefined, now)).toBeUndefined();
      expect((await readApiBalances(file, now))?.lines[0]).toContain("нет свежих данных");
      await writeFile(file, JSON.stringify(snapshot()));
      expect((await readApiBalances(file, now))?.recommendations).toHaveLength(1);
      await writeFile(file, "{broken");
      expect((await readApiBalances(file, now))?.recommendations).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
