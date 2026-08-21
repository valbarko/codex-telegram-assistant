import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AssistantJobBlockedError } from "./assistant-job-worker.js";

const execFileAsync = promisify(execFile);
const DELIVERY_ACTION = /(?:дела(?:ем|й)|сдела(?:й|ть)|сохран(?:и|ить)|добав(?:ь|ить)|перенес(?:и|ти)|полож(?:и|ить)|оформ(?:и|ить)|готов(?:им|ь)|додела(?:й|ть)|запиш(?:и|ем))/iu;
const ARTICLE_BANK = /банк(?:а|е|у|ом)?\s+статей/iu;

export type ArticleBankSnapshot = ReadonlyMap<string, string>;

export function isArticleBankDeliveryRequest(value: string): boolean {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return ARTICLE_BANK.test(normalized) && DELIVERY_ACTION.test(normalized);
}

export function articleBankExecutionPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "КОНТРАКТ ВЫПОЛНЕНИЯ ДЛЯ БАНКА СТАТЕЙ:",
    "Работай непосредственно в текущем workspace Банка статей. Сначала найди его локальные инструкции и существующий формат пакетов.",
    "Не ограничивайся черновиком в ответе: сохрани результат в articles/<slug>/, подготовь основной текст, Telegram, vc.ru, metadata и обе обложки 4:5 и 16:9.",
    "Перед финальным ответом проверь созданные файлы и запусти scripts/article_bank.py validate.",
    "Повторный запуск должен быть идемпотентным: сначала проверь уже созданный пакет и продолжи его, не создавая дубль.",
    "Если запись или обязательная проверка невозможны, прямо заверши ответ статусом БЛОКИРОВКА и укажи причину; не называй задачу выполненной.",
  ].join("\n");
}

export async function snapshotArticleBank(root: string): Promise<ArticleBankSnapshot> {
  const articles = path.join(root, "articles");
  const files = new Map<string, string>();
  await walk(articles, articles, files);
  return files;
}

export async function validateArticleBankDelivery(root: string, before: ArticleBankSnapshot): Promise<string[]> {
  const after = await snapshotArticleBank(root);
  const slugs = new Set<string>();
  for (const [file, signature] of after) {
    if (before.get(file) === signature) continue;
    const [slug] = file.split(path.sep);
    if (slug && !slug.startsWith(".")) slugs.add(slug);
  }
  if (!slugs.size) {
    throw new AssistantJobBlockedError(
      "Codex завершил ход, но не создал и не изменил пакет в articles/<slug>",
      "article_no_changes",
    );
  }

  const failures: string[] = [];
  const completed: string[] = [];
  for (const slug of slugs) {
    const missing = await missingPackageFiles(path.join(root, "articles", slug));
    if (missing.length) failures.push(`${slug}: ${missing.join(", ")}`);
    else completed.push(slug);
  }
  if (failures.length) {
    throw new AssistantJobBlockedError(`Пакет Банка статей неполный: ${failures.join("; ")}`, "article_incomplete");
  }

  try {
    const script = path.join(root, "scripts", "article_bank.py");
    const options = {
      cwd: root,
      timeout: 2 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    };
    await execFileAsync("python3", [script, "sync"], options);
    const validation = await execFileAsync("python3", [script, "validate"], options);
    const changedIssues = validation.stdout.split(/\r?\n/u)
      .map((line) => line.trim().replace(/^-\s*/u, ""))
      .filter((line) => completed.some((slug) => line.startsWith(`${slug}:`)));
    if (changedIssues.length) {
      throw new AssistantJobBlockedError(
        `Валидация изменённого пакета не прошла: ${changedIssues.join("; ")}`,
        "article_validation",
      );
    }
  } catch (error) {
    if (error instanceof AssistantJobBlockedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AssistantJobBlockedError(`Валидация Банка статей не прошла: ${message}`, "article_validation");
  }
  return completed;
}

async function missingPackageFiles(directory: string): Promise<string[]> {
  const missing: string[] = [];
  for (const file of ["metadata.json", "article.md", "telegram.md"]) {
    if (!await nonempty(path.join(directory, file))) missing.push(file);
  }
  if (!await nonempty(path.join(directory, "vc.md")) && !await nonempty(path.join(directory, "vc.txt"))) {
    missing.push("vc.md|vc.txt");
  }

  let media: Record<string, unknown> = {};
  try {
    const metadata = JSON.parse(await readFile(path.join(directory, "metadata.json"), "utf8")) as Record<string, unknown>;
    media = metadata.media && typeof metadata.media === "object" ? metadata.media as Record<string, unknown> : {};
  } catch {
    missing.push("metadata.json: invalid JSON");
  }
  const feed = typeof media.feed_4x5 === "string" ? media.feed_4x5 : "assets/cover-4x5.png";
  const article = typeof media.article_16x9 === "string" ? media.article_16x9 : "assets/cover-16x9.png";
  const feedFile = localPath(directory, feed);
  const articleFile = localPath(directory, article);
  if (!feedFile || !await nonempty(feedFile)) missing.push("cover 4:5");
  else if (!await hasPngRatio(feedFile, 4, 5)) missing.push("cover 4:5 dimensions");
  if (!articleFile || !await nonempty(articleFile)) missing.push("cover 16:9");
  else if (!await hasPngRatio(articleFile, 16, 9)) missing.push("cover 16:9 dimensions");
  return [...new Set(missing)];
}

function localPath(directory: string, relative: string): string | undefined {
  const root = path.resolve(directory);
  const target = path.resolve(root, relative);
  return target.startsWith(`${root}${path.sep}`) ? target : undefined;
}

async function nonempty(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function hasPngRatio(file: string, widthRatio: number, heightRatio: number): Promise<boolean> {
  try {
    const bytes = await readFile(file);
    if (bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") return false;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 && Math.abs(width / height - widthRatio / heightRatio) < 0.01;
  } catch {
    return false;
  }
}

async function walk(root: string, directory: string, result: Map<string, string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AssistantJobBlockedError(`Банк статей недоступен: ${message}`, "article_bank_unavailable");
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, absolute, result);
    else if (entry.isFile()) {
      const details = await stat(absolute);
      result.set(path.relative(root, absolute), `${details.size}:${details.mtimeMs}`);
    }
  }
}
