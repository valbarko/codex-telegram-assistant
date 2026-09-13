import { readFile } from "node:fs/promises";

export interface ApiBalanceSummary {
  lines: readonly string[];
  recommendations: readonly string[];
}

const providers = [
  { id: "google", label: "Google Gemini", currency: "TRY", symbol: "₺", threshold: 100 },
  { id: "openai", label: "OpenAI API", currency: "USD", symbol: "$", threshold: 5 },
] as const;
const maximumAgeMs = 2 * 60 * 60_000;
const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", dateStyle: "short" });
const time = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" });
const dateTime = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const money = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Reads a private snapshot collected before the digest; never calls paid APIs. */
export async function readApiBalances(file: string | undefined, now = Date.now()): Promise<ApiBalanceSummary | undefined> {
  if (!file) return undefined;
  try {
    const source = await readFile(file, "utf8");
    return summarizeApiBalances(source.length <= 32_768 ? JSON.parse(source) : undefined, now);
  } catch {
    return summarizeApiBalances(undefined, now);
  }
}

export function summarizeApiBalances(value: unknown, now = Date.now()): ApiBalanceSummary {
  const document = record(value);
  const balances = document?.version === 1 ? record(document.providers) : undefined;
  const recommendations: string[] = [];
  const lines = providers.map((provider) => {
    const item = record(balances?.[provider.id]);
    const checkedAt = typeof item?.checkedAt === "string" ? Date.parse(item.checkedAt) : NaN;
    const validDate = Number.isFinite(checkedAt) && checkedAt > 0 && checkedAt <= now;
    const fresh = validDate && now - checkedAt <= maximumAgeMs && day.format(checkedAt) === day.format(now);
    if (!fresh) {
      const last = validDate ? `; последняя проверка ${dateTime.format(checkedAt)} МСК` : "";
      return `- **${provider.label}**: нет свежих данных${last}.`;
    }
    if (item?.status !== "ok" || item.currency !== provider.currency
      || typeof item.amount !== "number" || !Number.isFinite(item.amount) || Math.abs(item.amount) > 1e12) {
      const reason = item?.status === "unavailable" && item.reason === "login_required"
        ? "нужно войти в кабинет" : "не удалось проверить";
      return `- **${provider.label}**: ${reason} (${time.format(checkedAt)} МСК).`;
    }
    const low = item.amount <= provider.threshold;
    if (low) recommendations.push(`Пополнить ${provider.label}: осталось ${money.format(item.amount)} ${provider.symbol}.`);
    return `- **${provider.label}: ${money.format(item.amount)} ${provider.symbol}**${low ? " · **пора пополнить**" : ""} · ${time.format(checkedAt)} МСК.`;
  });
  return { lines, recommendations };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
