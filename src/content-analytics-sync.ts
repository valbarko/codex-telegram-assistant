import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_ARTICLE_BANK_ROOT = path.resolve(import.meta.dirname, "../../valentin-writing");

export interface ContentAnalyticsSyncResult {
  telegram?: { status: string; records: number; reason?: string };
  instagram?: { status: string; records: number; reason?: string };
}

export type ContentAnalyticsSource = "all" | "telegram" | "instagram";

export interface SearchAnalyticsSyncResult {
  status: string;
  records: number;
  period_start?: string;
  period_end?: string;
  reason?: string;
  projects?: Record<string, { status: string; records: number; reason?: string }>;
}

export interface MetrikaAnalyticsSyncResult extends SearchAnalyticsSyncResult {}

export async function syncContentAnalytics(
  articleBankRoot = configuredArticleBankRoot(),
  execute: typeof execFileAsync = execFileAsync,
  source: ContentAnalyticsSource = "all",
): Promise<ContentAnalyticsSyncResult> {
  const script = path.join(articleBankRoot, "scripts", "sync_social_analytics.py");
  const args = source === "all" ? [script] : [script, "--source", source];
  let stdout: string;
  try {
    const result = await execute("python3", args, {
      cwd: articleBankRoot,
      timeout: 90_000,
      maxBuffer: 256 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    const structuredOutput = executionStdout(error);
    if (structuredOutput === undefined) throw error;
    stdout = structuredOutput;
  }
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Content analytics sync returned invalid JSON");
  await renderArticleBank(articleBankRoot, execute);
  return parsed as ContentAnalyticsSyncResult;
}

export function instagramAnalyticsAuthorizationFailed(result: ContentAnalyticsSyncResult): boolean {
  return result.instagram?.status === "failed"
    && ["instagram_http_401", "instagram_token_missing"].includes(result.instagram.reason ?? "");
}

export async function syncSearchAnalytics(
  articleBankRoot = configuredArticleBankRoot(),
  execute: typeof execFileAsync = execFileAsync,
): Promise<SearchAnalyticsSyncResult> {
  const script = path.join(articleBankRoot, "scripts", "sync_search_analytics.py");
  const { stdout } = await execute("python3", [script], {
    cwd: articleBankRoot,
    timeout: 180_000,
    maxBuffer: 256 * 1024,
  });
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Search analytics sync returned invalid JSON");
  await renderArticleBank(articleBankRoot, execute);
  return parsed as SearchAnalyticsSyncResult;
}

export async function syncMetrikaAnalytics(
  articleBankRoot = configuredArticleBankRoot(),
  execute: typeof execFileAsync = execFileAsync,
): Promise<MetrikaAnalyticsSyncResult> {
  const script = path.join(articleBankRoot, "scripts", "sync_metrika_analytics.py");
  const { stdout } = await execute("python3", [script], {
    cwd: articleBankRoot,
    timeout: 180_000,
    maxBuffer: 256 * 1024,
  });
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Metrika analytics sync returned invalid JSON");
  await renderArticleBank(articleBankRoot, execute);
  return parsed as MetrikaAnalyticsSyncResult;
}

async function renderArticleBank(
  articleBankRoot: string,
  execute: typeof execFileAsync,
): Promise<void> {
  await execute("python3", [path.join(articleBankRoot, "scripts", "article_bank.py"), "render"], {
    cwd: articleBankRoot,
    timeout: 90_000,
    maxBuffer: 256 * 1024,
  });
}

function configuredArticleBankRoot(): string {
  return path.resolve(process.env.VALENTIN_ARTICLE_BANK_ROOT?.trim() || DEFAULT_ARTICLE_BANK_ROOT);
}

function executionStdout(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("stdout" in error)) return undefined;
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === "string" ? stdout : undefined;
}
