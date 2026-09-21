import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AssistantJobBlockedError } from "./assistant-job-worker.js";

const execFileAsync = promisify(execFile);
const DELIVERY_ACTION = /(?:дела(?:ем|й)|сдела(?:й|ть)|сохран(?:и|ить)|добав(?:ь|ить)|перенес(?:и|ти)|полож(?:и|ить)|оформ(?:и|ить)|готов(?:им|ь)|додела(?:й|ть)|запиш(?:и|ем))/iu;
const ARTICLE_BANK = /банк(?:а|е|у|ом)?\s+статей/iu;
const RESEARCH_DIRECTORY = path.join(".private", "article-research");
const WRITING_MODES = new Set(["authorial", "reader_first_seo"]);
const SOURCE_VISIBILITIES = new Set(["public", "restricted", "internal", "confidential"]);
const SOURCE_AUTHORITIES = new Set(["primary", "secondary", "author"]);
const CLAIM_IMPORTANCE = new Set(["material", "supporting"]);
const CLAIM_RISKS = new Set(["normal", "unstable", "high_stakes"]);
const CLAIM_STATUSES = new Set(["verified", "qualified", "removed"]);
const PUBLICATION_USES = new Set(["cite", "paraphrase", "background_only", "exclude"]);

export type ArticleBankSnapshot = ReadonlyMap<string, string>;

export interface ArticleBankDeliveryResult {
  slugs: string[];
  outcome: "changed" | "already_exists";
}

interface ArticleBankDeliveryOptions {
  knownSlug?: string;
}

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
    "Обязательно используй навык make-valentin-article-package и его приватный контракт исследования.",
    "Не ограничивайся черновиком в ответе: сохрани результат в articles/<slug>/, подготовь основной текст, Telegram, vc.ru, metadata и обе обложки 4:5 и 16:9.",
    "До финала создай .private/article-research/<slug>/brief.md и claims.json. В claims.json записывай только существенные проверяемые утверждения; классифицируй источники как public, restricted, internal или confidential. Не выноси приватный бриф, реестр или внутренние ссылки в публичные файлы.",
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

export function serializeArticleBankSnapshot(snapshot: ArticleBankSnapshot): string {
  return JSON.stringify([...snapshot.entries()]);
}

export function deserializeArticleBankSnapshot(value: string): ArticleBankSnapshot {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Invalid article bank baseline");
  const entries = parsed.map((entry): [string, string] => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      throw new Error("Invalid article bank baseline entry");
    }
    return [entry[0], entry[1]];
  });
  return new Map(entries);
}

export async function validateArticleBankDelivery(root: string, before: ArticleBankSnapshot,
  options: ArticleBankDeliveryOptions = {}): Promise<ArticleBankDeliveryResult> {
  const after = await snapshotArticleBank(root);
  const slugs = new Set<string>();
  for (const [file, signature] of after) {
    if (before.get(file) === signature) continue;
    const [slug] = file.split(path.sep);
    if (slug && !slug.startsWith(".")) slugs.add(slug);
  }
  const changedSlugs = new Set(slugs);
  const knownSlug = safeSlug(options.knownSlug);
  const outcome = slugs.size ? "changed" : "already_exists";
  if (!slugs.size && knownSlug) slugs.add(knownSlug);
  if (!slugs.size) {
    throw new AssistantJobBlockedError(
      "Codex завершил ход, но не создал и не изменил пакет в articles/<slug>",
      "article_no_changes",
    );
  }

  const failures: string[] = [];
  const evidenceFailures: string[] = [];
  const completed: string[] = [];
  for (const slug of slugs) {
    const missing = await missingPackageFiles(path.join(root, "articles", slug));
    if (missing.length) failures.push(`${slug}: ${missing.join(", ")}`);
    else {
      const issues = await articleResearchIssues(root, slug, changedSlugs.has(slug));
      if (issues.length) evidenceFailures.push(`${slug}: ${issues.join(", ")}`);
      else completed.push(slug);
    }
  }
  if (failures.length) {
    throw new AssistantJobBlockedError(`Пакет Банка статей неполный: ${failures.join("; ")}`, "article_incomplete");
  }
  if (evidenceFailures.length) {
    throw new AssistantJobBlockedError(
      `Приватная проверка утверждений не прошла: ${evidenceFailures.join("; ")}`,
      "article_evidence",
    );
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
  return { slugs: completed, outcome };
}

async function articleResearchIssues(root: string, slug: string, required: boolean): Promise<string[]> {
  const directory = path.join(root, RESEARCH_DIRECTORY, slug);
  const brief = path.join(directory, "brief.md");
  const register = path.join(directory, "claims.json");
  const briefExists = await nonempty(brief);
  const registerExists = await nonempty(register);
  if (!required && !briefExists && !registerExists) return [];

  const issues: string[] = [];
  if (!briefExists) issues.push("missing .private research brief");
  if (!registerExists) issues.push("missing .private claim register");
  if (!briefExists || !registerExists) return issues;

  try {
    const parsed = JSON.parse(await readFile(register, "utf8")) as unknown;
    issues.push(...claimRegisterIssues(parsed, slug));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(`invalid claims.json (${message})`);
  }
  return issues;
}

function claimRegisterIssues(value: unknown, slug: string): string[] {
  if (!isRecord(value)) return ["claims.json must contain an object"];
  const issues: string[] = [];
  if (value.version !== 1) issues.push("claims.json version must be 1");
  if (value.slug !== slug) issues.push("claims.json slug does not match the article");
  if (!WRITING_MODES.has(textValue(value.mode))) issues.push("claims.json has an invalid writing mode");
  if (!Array.isArray(value.sources)) issues.push("claims.json sources must be an array");
  if (!Array.isArray(value.claims)) issues.push("claims.json claims must be an array");
  if (issues.length) return issues;

  const sources = new Map<string, Record<string, unknown>>();
  for (const [index, source] of (value.sources as unknown[]).entries()) {
    if (!isRecord(source)) {
      issues.push(`source ${index + 1} must be an object`);
      continue;
    }
    const id = textValue(source.id);
    if (!id) issues.push(`source ${index + 1} has no id`);
    else if (sources.has(id)) issues.push(`duplicate source id ${id}`);
    else sources.set(id, source);
    if (!textValue(source.reference)) issues.push(`source ${id || index + 1} has no reference`);
    if (!SOURCE_VISIBILITIES.has(textValue(source.visibility))) {
      issues.push(`source ${id || index + 1} has an invalid visibility`);
    }
    if (!SOURCE_AUTHORITIES.has(textValue(source.authority))) {
      issues.push(`source ${id || index + 1} has an invalid authority`);
    }
    if (!isoDate(textValue(source.checked_at))) issues.push(`source ${id || index + 1} has an invalid checked_at date`);
  }

  const claimIds = new Set<string>();
  for (const [index, claim] of (value.claims as unknown[]).entries()) {
    if (!isRecord(claim)) {
      issues.push(`claim ${index + 1} must be an object`);
      continue;
    }
    const id = textValue(claim.id);
    const label = id || String(index + 1);
    if (!id) issues.push(`claim ${index + 1} has no id`);
    else if (claimIds.has(id)) issues.push(`duplicate claim id ${id}`);
    else claimIds.add(id);
    if (!textValue(claim.statement)) issues.push(`claim ${label} has no statement`);
    if (!CLAIM_IMPORTANCE.has(textValue(claim.importance))) issues.push(`claim ${label} has an invalid importance`);
    const risk = textValue(claim.risk);
    if (!CLAIM_RISKS.has(risk)) issues.push(`claim ${label} has an invalid risk`);
    const status = textValue(claim.status);
    if (!CLAIM_STATUSES.has(status)) issues.push(`claim ${label} has an invalid status`);
    const publicationUse = textValue(claim.publication_use);
    if (!PUBLICATION_USES.has(publicationUse)) issues.push(`claim ${label} has an invalid publication_use`);
    if (status === "qualified" && !textValue(claim.limitations)) {
      issues.push(`qualified claim ${label} has no limitations`);
    }
    if (status === "removed" && publicationUse !== "exclude") {
      issues.push(`removed claim ${label} must be excluded`);
    }

    const sourceIds = Array.isArray(claim.source_ids)
      ? claim.source_ids.map(textValue).filter(Boolean)
      : [];
    if (status !== "removed" && !sourceIds.length) issues.push(`claim ${label} has no source`);
    const linked = sourceIds.map((sourceId) => {
      const source = sources.get(sourceId);
      if (!source) issues.push(`claim ${label} references unknown source ${sourceId}`);
      return source;
    }).filter((source): source is Record<string, unknown> => Boolean(source));

    if (publicationUse === "cite" && linked.some((source) => source.visibility !== "public")) {
      issues.push(`claim ${label} cites a non-public source`);
    }
    if (publicationUse === "paraphrase" && linked.some((source) => source.visibility === "confidential")) {
      issues.push(`claim ${label} paraphrases a confidential source`);
    }
    if (["unstable", "high_stakes"].includes(risk)
      && status !== "removed"
      && !linked.some((source) => source.authority === "primary")) {
      issues.push(`claim ${label} needs a primary source`);
    }
  }
  return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function safeSlug(value: string | undefined): string | undefined {
  const slug = value?.trim();
  return slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) ? slug : undefined;
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
