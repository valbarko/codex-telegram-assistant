import { createHash } from "node:crypto";

import type { ContentRadarPost, ContentRadarSourceRole } from "./content-radar.js";

const DEFAULT_LOOKBACK_DAYS = 21;
const DEFAULT_LIMIT = 24;
const MAX_ITEMS_PER_SOURCE = 3;
const REQUEST_ATTEMPTS = 2;

const PROMO_WORDS = [
  "sale", "discount", "black friday", "coupon", "limited-time", "limited time", "register now",
  "enroll now", "product update", "app update", "introducing recipes", "certification sale",
  "food logging updates", "case study", "meal prep", "recipe update", "new app feature",
] as const;

export interface WebsiteFeedSource {
  id: string;
  title: string;
  homepage: string;
  feedUrl: string;
  role: ContentRadarSourceRole;
  excludedUrlPrefixes?: readonly string[];
}

export const WEBSITE_FEED_SOURCES: readonly WebsiteFeedSource[] = [
  {
    id: "stronger-by-science",
    title: "Stronger by Science",
    homepage: "https://www.strongerbyscience.com/articles/",
    feedUrl: "https://www.strongerbyscience.com/articles/feed/",
    role: "evidence",
  },
  {
    id: "barbell-medicine",
    title: "Barbell Medicine",
    homepage: "https://www.barbellmedicine.com/blog/",
    feedUrl: "https://www.barbellmedicine.com/feed/",
    role: "evidence",
  },
  {
    id: "peter-attia",
    title: "Peter Attia",
    homepage: "https://peterattiamd.com/",
    feedUrl: "https://peterattiamd.com/feed/",
    role: "trend",
  },
  {
    id: "rp-strength",
    title: "Renaissance Periodization",
    homepage: "https://rpstrength.com/blogs/articles",
    feedUrl: "https://rpstrength.com/blogs/articles.atom",
    role: "expert",
  },
  {
    id: "sigma-nutrition",
    title: "Sigma Nutrition",
    homepage: "https://sigmanutrition.com/",
    feedUrl: "https://sigmanutrition.com/feed/",
    role: "evidence",
  },
  {
    id: "macrofactor",
    title: "MacroFactor",
    homepage: "https://macrofactorapp.com/articles/",
    feedUrl: "https://macrofactorapp.com/feed/",
    role: "evidence",
  },
  {
    id: "behavioral-scientist",
    title: "Behavioral Scientist",
    homepage: "https://behavioralscientist.org/",
    feedUrl: "https://behavioralscientist.org/feed/",
    role: "behavior",
  },
  {
    id: "menno-henselmans",
    title: "Menno Henselmans",
    homepage: "https://mennohenselmans.com/posts/",
    // The site blocks unattended RSS/HTML requests. Its official YouTube Atom
    // feed carries the same research videos with descriptions and study links.
    feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCmO2dykYM3nlb5BtsXxp9ZQ",
    role: "expert",
    excludedUrlPrefixes: ["https://www.youtube.com/shorts/"],
  },
] as const;

export const HUBERMAN_SOURCE = {
  id: "huberman-lab",
  title: "Huberman Lab",
  homepage: "https://www.hubermanlab.com/podcast",
  role: "trend" as const,
};

export interface WebsiteRadarOptions {
  now?: number;
  lookbackDays?: number;
  limit?: number;
  usedSourceIds?: ReadonlySet<string>;
  requester?: typeof fetch;
  sources?: readonly WebsiteFeedSource[];
}

export async function collectWebsiteRadarPosts(options: WebsiteRadarOptions = {}): Promise<ContentRadarPost[]> {
  const requester = options.requester ?? fetch;
  const sources = options.sources ?? WEBSITE_FEED_SOURCES;
  const requests = sources.map(async (source) => parseWebsiteFeed(await requestSource(source.feedUrl, requester), source));
  if (!options.sources) requests.push(collectHubermanPosts(requester));
  const results = await Promise.allSettled(requests);
  const posts = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  return selectWebsiteRadarPosts(posts, options);
}

export function parseHubermanIndex(html: string): Array<{ title: string; sourceUrl: string; publishedAt: number }> {
  const found = [...html.matchAll(/<a\s+episode-card=""\s+href="(\/episode\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/giu)]
    .flatMap((match) => {
      const body = match[2] ?? "";
      const title = cleanXmlText(body.match(/<h3\b[^>]*card-title=""[^>]*>([\s\S]*?)<\/h3>/iu)?.[1] ?? "");
      const dateSource = cleanXmlText(body.match(/<div\b[^>]*class="[^"]*paragraph-small[^"]*"[^>]*>([^<]+)<\/div>/iu)?.[1] ?? "");
      const publishedAt = Date.parse(dateSource);
      if (!title || !Number.isFinite(publishedAt)) return [];
      return [{ title, sourceUrl: new URL(match[1]!, "https://www.hubermanlab.com").toString(), publishedAt }];
    });
  const seen = new Set<string>();
  return found.filter((item) => !seen.has(item.sourceUrl) && Boolean(seen.add(item.sourceUrl)))
    .sort((left, right) => right.publishedAt - left.publishedAt);
}

export function parseWebsiteFeed(xml: string, source: WebsiteFeedSource): ContentRadarPost[] {
  const entries = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/giu)];
  return entries.flatMap((match) => {
    const entry = match[2] ?? "";
    const title = cleanXmlText(firstXmlValue(entry, "title"));
    const sourceUrl = entryLink(entry, match[1]?.toLocaleLowerCase("en-US") === "entry");
    const dateSource = firstXmlValue(entry, "pubDate") || firstXmlValue(entry, "published")
      || firstXmlValue(entry, "updated") || firstXmlValue(entry, "dc:date");
    const publishedAt = Date.parse(cleanXmlText(dateSource));
    const description = firstXmlValue(entry, "content:encoded") || firstXmlValue(entry, "content")
      || firstXmlValue(entry, "description") || firstXmlValue(entry, "summary")
      || firstXmlValue(entry, "media:description");
    const body = cleanXmlText(description);
    if (!title || !sourceUrl || !Number.isFinite(publishedAt)
      || source.excludedUrlPrefixes?.some((prefix) => sourceUrl.startsWith(prefix))) return [];
    const externalLinks = extractLinks(description).filter((link) => link !== sourceUrl);
    const stableId = cleanXmlText(firstXmlValue(entry, "guid") || firstXmlValue(entry, "id")) || sourceUrl;
    return [{
      sourceId: `website:${source.id}:${hash(stableId)}`,
      sourceKind: "website" as const,
      sourceRole: source.role,
      sourceTitle: source.title,
      publishedAt,
      text: `${title}. ${body}`.replace(/\s+/gu, " ").trim().slice(0, 8_000),
      links: externalLinks,
      sourceUrl,
    }];
  });
}

export function selectWebsiteRadarPosts(
  posts: readonly ContentRadarPost[],
  options: Pick<WebsiteRadarOptions, "now" | "lookbackDays" | "limit" | "usedSourceIds"> = {},
): ContentRadarPost[] {
  const now = options.now ?? Date.now();
  const cutoff = now - (options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 86_400_000;
  const counts = new Map<string, number>();
  return [...posts].sort((left, right) => right.publishedAt - left.publishedAt).filter((post) => {
    if (post.publishedAt < cutoff || post.publishedAt > now + 5 * 60_000
      || options.usedSourceIds?.has(post.sourceId) || post.text.length < 100 || promotional(post.text)) return false;
    const count = counts.get(post.sourceTitle) ?? 0;
    if (count >= MAX_ITEMS_PER_SOURCE) return false;
    counts.set(post.sourceTitle, count + 1);
    return true;
  }).slice(0, options.limit ?? DEFAULT_LIMIT);
}

async function collectHubermanPosts(requester: typeof fetch): Promise<ContentRadarPost[]> {
  const index = parseHubermanIndex(await requestSource(HUBERMAN_SOURCE.homepage, requester)).slice(0, 6);
  const details = await Promise.allSettled(index.map(async (item) => {
    const html = await requestSource(item.sourceUrl, requester);
    const notes = cleanXmlText(html.match(/<div\b[^>]*class="[^"]*rich-text-episode-notes[^"]*"[^>]*>([\s\S]*?)<\/div>/iu)?.[1] ?? "");
    return {
      sourceId: `website:${HUBERMAN_SOURCE.id}:${hash(item.sourceUrl)}`,
      sourceKind: "website" as const,
      sourceRole: HUBERMAN_SOURCE.role,
      sourceTitle: HUBERMAN_SOURCE.title,
      publishedAt: item.publishedAt,
      text: `${item.title}. ${notes}`.replace(/\s+/gu, " ").trim().slice(0, 8_000),
      links: extractLinks(html).filter((link) => !link.startsWith("https://www.hubermanlab.com/")),
      sourceUrl: item.sourceUrl,
    } satisfies ContentRadarPost;
  }));
  return details.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}

async function requestSource(url: string, requester: typeof fetch): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await requester(url, {
        headers: { "User-Agent": "codex-telegram-assistant/0.1 (personal content radar)" },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return response.text();
      lastError = new Error(`Website feed HTTP ${response.status}: ${url}`);
      if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Website source failed: ${url}`);
}

function entryLink(entry: string, atom: boolean): string | undefined {
  const value = atom
    ? [...entry.matchAll(/<link\b([^>]*)\/?\s*>/giu)].map((match) => match[1] ?? "").find((attributes) => {
      const rel = attribute(attributes, "rel");
      return !rel || rel === "alternate";
    })
    : undefined;
  const link = atom ? attribute(value ?? "", "href") : cleanXmlText(firstXmlValue(entry, "link"));
  try {
    const parsed = new URL(link);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function attribute(source: string, name: string): string {
  return decodeXml(source.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "iu"))?.[1] ?? "");
}

function firstXmlValue(source: string, name: string): string {
  return source.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "iu"))?.[1] ?? "";
}

function cleanXmlText(value: string): string {
  return decodeXml(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/giu, "$1").replace(/<[^>]+>/gu, " "))
    .replace(/[\u00a0\s]+/gu, " ").trim();
}

function decodeXml(value: string): string {
  return value.replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&nbsp;", " ").replaceAll("&quot;", "\"").replaceAll("&apos;", "'")
    .replaceAll("&#8217;", "’").replaceAll("&#8211;", "–").replaceAll("&#8212;", "—")
    .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function extractLinks(value: string): string[] {
  const encoded = [...value.matchAll(/\bhref=["']([^"']+)["']/giu)].map((match) => decodeXml(match[1] ?? ""));
  const plain = (value.match(/https?:\/\/[^\s<>"']+/giu) ?? []).map(decodeXml);
  return [...new Set([...encoded, ...plain].flatMap((link) => {
    try {
      const parsed = new URL(link.replace(/[),.;!?]+$/u, ""));
      return parsed.protocol === "https:" ? [parsed.toString()] : [];
    } catch {
      return [];
    }
  }))];
}

function promotional(value: string): boolean {
  const normalized = value.toLocaleLowerCase("en-US");
  return PROMO_WORDS.some((word) => normalized.includes(word));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}
