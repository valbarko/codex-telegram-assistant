import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { AppConfiguration } from "./configuration.js";
import { loadTelegramReaderCredentials } from "./telegram-reader-keychain.js";
import {
  readTelegramReaderState,
  TelegramChannelReader,
  type TelegramChannel,
  type TelegramChannelMessage,
} from "./telegram-reader.js";

const execFileAsync = promisify(execFile);
const OWN_CHANNELS = [
  { username: "valbarko", title: "БАРКО ПРО ЖИЗНЬ" },
  { username: "valbarkoclub", title: "Валентин Барко | В СВОЁМ ТЕЛЕ" },
] as const;
const DEFAULT_ARTICLE_BANK_ROOT = path.resolve(import.meta.dirname, "../../valentin-writing");

export interface ArticleReference {
  slug: string;
  title: string;
}

export interface TelegramArticlePublication {
  article_slug: string;
  article_title: string;
  channel_title: string;
  channel_username: string;
  message_id: number;
  published_at: string;
  url: string;
  views?: number;
  forwards?: number;
}

export interface TelegramPublicationSnapshot {
  schema_version: 1;
  synced_at: string;
  source: "telegram_user_api";
  channels: readonly { title: string; username: string }[];
  publications: readonly TelegramArticlePublication[];
}

export async function syncTelegramArticlePublications(
  configuration: Pick<AppConfiguration, "dataDirectory">,
  articleBankRoot = configuredArticleBankRoot(),
): Promise<TelegramPublicationSnapshot | undefined> {
  if (!await isDirectory(path.join(articleBankRoot, "articles"))) return undefined;
  const readerDirectory = path.join(configuration.dataDirectory, "telegram-reader");
  const [credentials, state, articles] = await Promise.all([
    loadTelegramReaderCredentials(),
    readTelegramReaderState(readerDirectory),
    loadArticleReferences(articleBankRoot),
  ]);
  if (!credentials || !state || !articles.length) return undefined;
  const channels = ownPublicationChannels(state.allowedChannels);
  if (!channels.length) return undefined;

  const reader = new TelegramChannelReader(credentials, readerDirectory);
  const detected: TelegramArticlePublication[] = [];
  try {
    await reader.login({});
    for (const channel of channels) {
      const messages = await reader.readRecentFresh(channel, 100);
      for (const message of messages) {
        const article = matchTelegramPublication(articles, message.text);
        if (!article || !channel.username) continue;
        const url = await reader.messageLink(message)
          || `https://t.me/${channel.username.replace(/^@/u, "")}/${message.messageId}`;
        detected.push(publicationRecord(article, channel, message, url));
      }
    }
  } finally {
    await reader.close();
  }

  const target = path.join(articleBankRoot, "data", "telegram-publications.json");
  const previous = await loadSnapshot(target);
  const publications = mergePublications(previous?.publications ?? [], detected);
  const snapshot: TelegramPublicationSnapshot = {
    schema_version: 1,
    synced_at: new Date().toISOString(),
    source: "telegram_user_api",
    channels: channels.map((channel) => ({
      title: channel.title,
      username: channel.username!.replace(/^@/u, ""),
    })),
    publications,
  };
  const changed = publicationFingerprint(previous) !== publicationFingerprint(snapshot);
  await atomicWriteJson(target, snapshot);
  if (changed) await renderArticleBank(articleBankRoot);
  return snapshot;
}

export function matchTelegramPublication(
  articles: readonly ArticleReference[],
  messageText: string,
): ArticleReference | undefined {
  const normalizedMessage = normalizeForMatch(messageText);
  return articles
    .filter((article) => {
      const title = normalizeForMatch(article.title);
      return title.length >= 12 && normalizedMessage.includes(title);
    })
    .sort((left, right) => normalizeForMatch(right.title).length - normalizeForMatch(left.title).length)[0];
}

export function normalizeForMatch(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function configuredArticleBankRoot(): string {
  return path.resolve(process.env.VALENTIN_ARTICLE_BANK_ROOT?.trim() || DEFAULT_ARTICLE_BANK_ROOT);
}

async function loadArticleReferences(root: string): Promise<ArticleReference[]> {
  const articleRoot = path.join(root, "articles");
  const entries = await readdir(articleRoot, { withFileTypes: true });
  const articles = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try {
      const metadata = JSON.parse(await readFile(path.join(articleRoot, entry.name, "metadata.json"), "utf8")) as unknown;
      if (!metadata || typeof metadata !== "object") return undefined;
      const title = "title" in metadata && typeof metadata.title === "string" ? metadata.title.trim() : "";
      return title ? { slug: entry.name, title } : undefined;
    } catch {
      return undefined;
    }
  }));
  return articles.filter((article): article is ArticleReference => Boolean(article));
}

function ownPublicationChannels(channels: readonly TelegramChannel[]): TelegramChannel[] {
  return OWN_CHANNELS.flatMap((configured) => {
    const channel = channels.find((candidate) => {
      const username = candidate.username?.replace(/^@/u, "").toLocaleLowerCase("en-US");
      return username === configured.username || candidate.title.trim() === configured.title;
    });
    return channel ? [{ ...channel, username: configured.username }] : [];
  });
}

function publicationRecord(
  article: ArticleReference,
  channel: TelegramChannel,
  message: TelegramChannelMessage,
  url: string,
): TelegramArticlePublication {
  return {
    article_slug: article.slug,
    article_title: article.title,
    channel_title: channel.title,
    channel_username: channel.username!.replace(/^@/u, ""),
    message_id: message.messageId,
    published_at: new Date(message.publishedAt).toISOString(),
    url,
    ...(message.views === undefined ? {} : { views: message.views }),
    ...(message.forwards === undefined ? {} : { forwards: message.forwards }),
  };
}

function mergePublications(
  previous: readonly TelegramArticlePublication[],
  detected: readonly TelegramArticlePublication[],
): TelegramArticlePublication[] {
  const records = new Map(previous.map((item) => [`${item.channel_username}:${item.message_id}`, item]));
  for (const item of detected) records.set(`${item.channel_username}:${item.message_id}`, item);
  return [...records.values()].sort((left, right) => right.published_at.localeCompare(left.published_at));
}

async function loadSnapshot(file: string): Promise<TelegramPublicationSnapshot | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as TelegramPublicationSnapshot;
    return value?.schema_version === 1 && Array.isArray(value.publications) ? value : undefined;
  } catch {
    return undefined;
  }
}

function publicationFingerprint(snapshot: TelegramPublicationSnapshot | undefined): string {
  if (!snapshot) return "";
  return JSON.stringify(snapshot.publications.map((item) => [
    item.article_slug, item.channel_username, item.message_id, item.published_at, item.url, item.views, item.forwards,
  ]));
}

async function atomicWriteJson(file: string, value: TelegramPublicationSnapshot): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

async function renderArticleBank(root: string): Promise<void> {
  await execFileAsync("python3", ["scripts/article_bank.py", "render"], { cwd: root, timeout: 60_000 });
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}
