const MOSCOW_TIME_ZONE = "Europe/Moscow";
const SOURCE_ATTEMPTS = 3;
const SOURCE_RETRY_DELAYS = [400, 1_200] as const;
const MAX_DAYS = 3;

const RUSSIAN_MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
] as const;

interface CalendHoliday {
  title: string;
  link: string;
  description: string;
  category: string;
  index: number;
}

interface WikiPage {
  title?: unknown;
  content_urls?: { desktop?: { page?: unknown } };
}

interface WikiEntry {
  text?: unknown;
  pages?: unknown;
}

interface WikiFeed {
  holidays?: unknown;
}

interface DisplayDay {
  title: string;
  link?: string;
  index: number;
  score: number;
}

const BLOG_DAY_TOPIC = /(тренер|фитнес|физкультур|упражнен|движени|здоров|питани|диетолог|нутрици|белок|протеин|витамин|минерал|психолог|психическ|ментальн|привыч|сон|врач|медицин|реабилит|физиотерап|массаж|йог|донор|сердц|диабет|ожирен)/u;
const BLOCKED_TOPIC = /(войн|военн|боев|битв|сражен|фронт|армия|флот|побед|оккупац|блокад|бомбард|оружи|террор|репресс|катастроф|политик|президент|революц)/u;
const BLOCKED_SPORT_TITLE = /(футбол|хоккей|баскетбол|волейбол|теннис|бокс|матч|турнир|чемпионат|олимпиад|спортсмен|шахмат|гонк)/u;

export async function todayInspiration(
  now = Date.now(),
  requester: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = delay,
): Promise<string | undefined> {
  const date = moscowDate(now);
  const [calendResult, wikiResult] = await Promise.allSettled([
    fetchCalendHolidays(date, requester, wait),
    fetchWikiFeed(date, requester, wait),
  ]);
  const calend = calendResult.status === "fulfilled" ? calendResult.value : [];
  const wiki = wikiResult.status === "fulfilled" ? wikiResult.value : undefined;
  const days = calend.length ? selectCalendDays(calend) : selectWikiDays(wiki);

  return days.length ? formatInspiration(now, days) : undefined;
}

function formatInspiration(now: number, days: readonly DisplayDay[]): string {
  const dateLabel = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long", day: "numeric", month: "long", timeZone: MOSCOW_TIME_ZONE,
  }).format(new Date(now));
  return [
    `📌 **Сегодня · ${dateLabel}**`,
    "",
    "**Памятные дни и поводы для блога**",
    "",
    ...days.map((day) => `- ${markdownLink(day.title, day.link)}`),
  ].join("\n");
}

async function fetchCalendHolidays(
  date: MoscowDate,
  requester: typeof fetch,
  wait: (milliseconds: number) => Promise<void>,
): Promise<CalendHoliday[]> {
  const response = await requestSource("https://www.calend.ru/rss/today-holidays.rss", requester, wait);
  return parseCalendRss(await response.text(), date);
}

async function fetchWikiFeed(
  date: MoscowDate,
  requester: typeof fetch,
  wait: (milliseconds: number) => Promise<void>,
): Promise<WikiFeed> {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  const response = await requestSource(`https://ru.wikipedia.org/api/rest_v1/feed/onthisday/holidays/${month}/${day}`, requester, wait);
  return await response.json() as WikiFeed;
}

async function requestSource(
  url: string,
  requester: typeof fetch,
  wait: (milliseconds: number) => Promise<void>,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < SOURCE_ATTEMPTS; attempt += 1) {
    try {
      const response = await requester(url, {
        headers: { "User-Agent": "codex-telegram-assistant/0.1 (personal morning digest)" },
        signal: AbortSignal.timeout(6_000),
      });
      if (response.ok) return response;
      const responseError = new Error(`daily inspiration HTTP ${response.status}`);
      lastError = responseError;
      if (!retryableStatus(response.status)) throw new NonRetryableSourceError(responseError.message);
    } catch (error) {
      if (error instanceof NonRetryableSourceError) throw error;
      lastError = error;
    }
    if (attempt < SOURCE_ATTEMPTS - 1) await wait(SOURCE_RETRY_DELAYS[attempt] ?? SOURCE_RETRY_DELAYS.at(-1)!);
  }
  throw lastError instanceof Error ? lastError : new Error("daily inspiration request failed");
}

class NonRetryableSourceError extends Error {}

export function parseCalendRss(source: string, date: MoscowDate): CalendHoliday[] {
  const prefix = `${date.day} ${RUSSIAN_MONTHS[date.month - 1]} ${date.year} - `;
  return [...source.matchAll(/<item>([\s\S]*?)<\/item>/giu)].flatMap((match, index) => {
    const item = match[1] ?? "";
    const rawTitle = xmlField(item, "title");
    if (!rawTitle.startsWith(prefix)) return [];
    const title = cleanText(rawTitle.slice(prefix.length));
    const link = cleanUrl(xmlField(item, "link"));
    if (!title || !link) return [];
    return [{
      title,
      link,
      description: cleanText(xmlField(item, "description")),
      category: cleanText(xmlField(item, "category")),
      index,
    }];
  });
}

function selectCalendDays(holidays: readonly CalendHoliday[]): DisplayDay[] {
  return holidays.flatMap((holiday) => {
    const candidate = `${holiday.title} ${holiday.category}`.toLocaleLowerCase("ru-RU");
    if (!usefulBlogDay(holiday.title, candidate)) return [];
    return [{
      title: holiday.title,
      link: holiday.link,
      index: holiday.index,
      score: blogDayScore(candidate),
    }];
  }).sort((left, right) => right.score - left.score || left.index - right.index).slice(0, MAX_DAYS);
}

function selectWikiDays(feed: WikiFeed | undefined): DisplayDay[] {
  return wikiEntries(feed?.holidays).flatMap((entry, index) => {
    const title = cleanText(stringValue(entry.text)).replace(/^[-—–]\s*/u, "").replace(/[.;]+$/u, "");
    if (!usefulBlogDay(title, title.toLocaleLowerCase("ru-RU"))) return [];
    return [{ title, link: relevantWikiPage(entry), index, score: blogDayScore(title) }];
  }).sort((left, right) => right.score - left.score || left.index - right.index).slice(0, MAX_DAYS);
}

function usefulBlogDay(title: string, candidate: string): boolean {
  const lowerTitle = title.toLocaleLowerCase("ru-RU");
  if (!title || title.includes("\n") || BLOCKED_TOPIC.test(candidate) || BLOCKED_SPORT_TITLE.test(lowerTitle)) return false;
  return BLOG_DAY_TOPIC.test(candidate) && /(день|праздник|недел|ночь)/u.test(lowerTitle);
}

function blogDayScore(value: string): number {
  const lower = value.toLocaleLowerCase("ru-RU");
  let score = 0;
  if (/(тренер|фитнес|физкультур|упражнен|движени)/u.test(lower)) score += 240;
  if (/(питани|диетолог|нутрици|белок|протеин|витамин|минерал)/u.test(lower)) score += 220;
  if (/(психолог|психическ|ментальн|привыч)/u.test(lower)) score += 200;
  if (/(сон|здоров|врач|медицин|реабилит|физиотерап|массаж|йог|донор|сердц|диабет|ожирен)/u.test(lower)) score += 170;
  return score;
}

function relevantWikiPage(entry: WikiEntry): string | undefined {
  const page = wikiPages(entry.pages)[0];
  const link = cleanUrl(stringValue(page?.content_urls?.desktop?.page));
  if (link) return link;
  const title = cleanText(stringValue(page?.title).replaceAll("_", " "));
  return title ? `https://ru.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}` : undefined;
}

function wikiEntries(value: unknown): WikiEntry[] {
  return Array.isArray(value) ? value.filter((item): item is WikiEntry => Boolean(item) && typeof item === "object") : [];
}

function wikiPages(value: unknown): WikiPage[] {
  return Array.isArray(value) ? value.filter((item): item is WikiPage => Boolean(item) && typeof item === "object") : [];
}

function xmlField(item: string, name: string): string {
  const match = item.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "iu"));
  return decodeXml((match?.[1] ?? "").replace(/^<!\[CDATA\[/u, "").replace(/\]\]>$/u, ""));
}

function decodeXml(value: string): string {
  return value.replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&nbsp;", " ").replaceAll("&laquo;", "«").replaceAll("&raquo;", "»")
    .replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function cleanText(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/gu, " ")).replace(/[\u00a0\s]+/gu, " ").trim();
}

function cleanUrl(value: string): string | undefined {
  const url = cleanText(value);
  return /^https:\/\//u.test(url) ? url : undefined;
}

function markdownLink(label: string, link?: string): string {
  const safeLabel = label.replace(/[\[\]]/gu, "");
  return link ? `[${safeLabel}](${link})` : safeLabel;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface MoscowDate {
  year: number;
  month: number;
  day: number;
}

function moscowDate(now: number): MoscowDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "numeric", day: "numeric", timeZone: MOSCOW_TIME_ZONE,
  }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
