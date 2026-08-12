import path from "node:path";

import type { AppConfiguration } from "./configuration.js";
import type { ContentRadarPost } from "./content-radar.js";
import { loadTelegramReaderCredentials } from "./telegram-reader-keychain.js";
import {
  readTelegramReaderState,
  TelegramChannelReader,
  type TelegramChannel,
  type TelegramChannelMessage,
} from "./telegram-reader.js";

const DEFAULT_LOOKBACK_HOURS = 48;
const DEFAULT_MESSAGES_PER_CHANNEL = 12;
const DEFAULT_CANDIDATE_LIMIT = 48;
const MAX_POSTS_PER_CHANNEL = 3;

const RELEVANCE_WORDS = [
  "мышц", "гипертроф", "силов", "тренир", "нагруз", "упражнен", "кардио", "фитнес",
  "белок", "питан", "диет", "аппетит", "сытост", "вес", "ожир", "калори", "рпп",
  "сон", "восстанов", "устал", "стресс", "боль", "сустав", "позвоноч", "реабилит",
  "психолог", "психотерап", "поведен", "привыч", "мотивац", "кпт",
  "креатин", "кофеин", "витамин", "добавк", "нутрици",
] as const;

const EVIDENCE_WORDS = [
  "исследован", "метаанализ", "мета-анализ", "систематическ", "рандомиз", "выборк", "участник",
  "pubmed", "doi", "журнал", "учёные", "ученые", "результат", "обзор",
] as const;

const PROMO_WORDS = [
  "скидк", "промокод", "купить", "покупк", "регистрац", "вебинар", "курс", "марафон",
  "осталось мест", "записаться", "записывайтесь", "розыгрыш", "реклама", "партнёрск", "партнерск",
] as const;

export interface TelegramRadarPost extends TelegramChannelMessage, ContentRadarPost {
  sourceKind: "telegram";
  channelTitle: string;
  channelUsername?: string;
  sourceUrl?: string;
}

export interface TelegramRadarSelectionOptions {
  now?: number;
  lookbackHours?: number;
  limit?: number;
  usedSourceIds?: ReadonlySet<string>;
}

export interface CollectTelegramRadarOptions extends TelegramRadarSelectionOptions {
  messagesPerChannel?: number;
}

export async function collectTelegramRadarPosts(
  configuration: Pick<AppConfiguration, "dataDirectory">,
  options: CollectTelegramRadarOptions = {},
): Promise<TelegramRadarPost[]> {
  const directory = path.join(configuration.dataDirectory, "telegram-reader");
  const [credentials, state] = await Promise.all([
    loadTelegramReaderCredentials(),
    readTelegramReaderState(directory),
  ]);
  if (!credentials || !state?.allowedChannels.length) return [];

  const reader = new TelegramChannelReader(credentials, directory);
  try {
    await reader.login({});
    const batches = await Promise.allSettled(state.allowedChannels.map(async (channel) => ({
      channel,
      messages: await reader.readRecent(channel, options.messagesPerChannel ?? DEFAULT_MESSAGES_PER_CHANNEL),
    })));
    const posts = batches.flatMap((batch) => {
      if (batch.status === "rejected") return [];
      return batch.value.messages.map((message) => radarPost(batch.value.channel, message));
    });
    const selected = selectTelegramRadarPosts(posts, options);
    return Promise.all(selected.map(async (post) => ({
      ...post,
      sourceUrl: post.sourceUrl || await reader.messageLink(post) || publicMessageLink(post),
    })));
  } finally {
    await reader.close();
  }
}

export function selectTelegramRadarPosts(
  posts: readonly TelegramRadarPost[],
  options: TelegramRadarSelectionOptions = {},
): TelegramRadarPost[] {
  const now = options.now ?? Date.now();
  const cutoff = now - (options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 60 * 60_000;
  const limit = options.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const scored = posts.flatMap((post) => {
    if (post.publishedAt < cutoff || post.publishedAt > now + 5 * 60_000
      || options.usedSourceIds?.has(post.sourceId)) return [];
    const normalized = normalize(post.text);
    if (normalized.length < 100) return [];
    const relevance = occurrences(normalized, RELEVANCE_WORDS);
    const evidence = occurrences(normalized, EVIDENCE_WORDS) + primarySourceLinks(post.links).length * 2;
    const promotion = occurrences(normalized, PROMO_WORDS);
    if (!relevance || (promotion >= 2 && evidence === 0)) return [];
    const ageHours = Math.max(0, (now - post.publishedAt) / 3_600_000);
    const recency = Math.max(0, DEFAULT_LOOKBACK_HOURS - ageHours) / 8;
    const reach = Math.log10(Math.max(1, (post.views ?? 0) + (post.forwards ?? 0) * 20));
    const substance = Math.min(4, normalized.length / 500);
    return [{ post, normalized, score: relevance * 3 + evidence * 5 + recency + reach + substance }];
  }).sort((left, right) => right.score - left.score || right.post.publishedAt - left.post.publishedAt);

  const selected: Array<{ post: TelegramRadarPost; normalized: string }> = [];
  const channelCounts = new Map<number, number>();
  for (const candidate of scored) {
    if ((channelCounts.get(candidate.post.chatId) ?? 0) >= MAX_POSTS_PER_CHANNEL) continue;
    if (selected.some((item) => nearDuplicate(item.normalized, candidate.normalized))) continue;
    selected.push(candidate);
    channelCounts.set(candidate.post.chatId, (channelCounts.get(candidate.post.chatId) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected.map((item) => item.post);
}

export function telegramRadarSourceId(message: Pick<TelegramChannelMessage, "chatId" | "messageId">): string {
  return `telegram:${message.chatId}:${message.messageId}`;
}

export function primarySourceLinks(links: readonly string[] | undefined): string[] {
  return (links ?? []).filter((link) => {
    try {
      const host = new URL(link).hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "");
      return host !== "t.me" && host !== "telegram.me" && !host.endsWith("tgstat.ru");
    } catch {
      return false;
    }
  });
}

function radarPost(channel: TelegramChannel, message: TelegramChannelMessage): TelegramRadarPost {
  return {
    ...message,
    sourceId: telegramRadarSourceId(message),
    sourceKind: "telegram",
    sourceRole: "trend",
    sourceTitle: channel.title,
    channelTitle: channel.title,
    channelUsername: channel.username,
    sourceUrl: channel.username ? `https://t.me/${channel.username}/${message.messageId}` : undefined,
  };
}

function publicMessageLink(post: TelegramRadarPost): string | undefined {
  return post.channelUsername ? `https://t.me/${post.channelUsername}/${post.messageId}` : undefined;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/https?:\/\/\S+/giu, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function occurrences(value: string, needles: readonly string[]): number {
  return needles.reduce((sum, needle) => sum + (value.includes(needle) ? 1 : 0), 0);
}

function nearDuplicate(left: string, right: string): boolean {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return false;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  const union = leftTokens.size + rightTokens.size - intersection;
  return intersection / union >= 0.62;
}

function tokens(value: string): Set<string> {
  return new Set(value.split(" ").filter((token) => token.length >= 4));
}
