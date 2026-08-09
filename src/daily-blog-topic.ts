const MOSCOW_TIME_ZONE = "Europe/Moscow";
const SOURCE_ATTEMPTS = 3;
const SOURCE_RETRY_DELAYS = [400, 1_200] as const;
const PUBMED_BATCH_SIZE = 12;

export type BlogTopicPillar = "training" | "nutrition" | "supplements" | "recovery" | "behavior";

export interface BlogStudy {
  sourceId: string;
  pillar: BlogTopicPillar;
  pillarLabel: string;
  title: string;
  abstract: string;
  publication?: string;
  year?: number;
  sourceUrl: string;
}

export interface DailyBlogStudyOptions {
  now?: number;
  usedSourceIds?: ReadonlySet<string>;
  requester?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
}

const PILLARS: readonly { id: BlogTopicPillar; label: string; query: string }[] = [
  {
    id: "training",
    label: "тренировки и адаптация",
    query: "((resistance training[Title/Abstract]) OR (strength training[Title/Abstract])) AND (muscle hypertrophy OR muscle strength OR muscle soreness) AND humans[MeSH Terms] AND hasabstract[text] AND (systematic review[Publication Type] OR meta-analysis[Publication Type] OR randomized controlled trial[Publication Type])",
  },
  {
    id: "nutrition",
    label: "питание и белок",
    query: "((dietary protein[Title/Abstract]) OR (protein intake[Title/Abstract])) AND (muscle protein synthesis OR satiety OR appetite OR body composition) AND humans[MeSH Terms] AND hasabstract[text] AND (systematic review[Publication Type] OR meta-analysis[Publication Type] OR randomized controlled trial[Publication Type])",
  },
  {
    id: "supplements",
    label: "витамины и добавки",
    query: "(creatine OR caffeine OR vitamin D OR magnesium OR beta-alanine OR dietary supplements) AND (exercise OR muscle OR physical performance) AND humans[MeSH Terms] AND hasabstract[text] AND (systematic review[Publication Type] OR meta-analysis[Publication Type] OR randomized controlled trial[Publication Type])",
  },
  {
    id: "recovery",
    label: "сон, боль и восстановление",
    query: "(sleep OR recovery OR delayed onset muscle soreness OR muscle pain) AND (exercise OR skeletal muscle) AND humans[MeSH Terms] AND hasabstract[text] AND (systematic review[Publication Type] OR meta-analysis[Publication Type] OR randomized controlled trial[Publication Type])",
  },
  {
    id: "behavior",
    label: "пищевое поведение и привычки",
    query: "(cognitive behavioral therapy OR habit formation OR eating behavior) AND (physical activity OR nutrition OR weight management) AND humans[MeSH Terms] AND hasabstract[text] AND (systematic review[Publication Type] OR meta-analysis[Publication Type] OR randomized controlled trial[Publication Type])",
  },
] as const;

export async function findDailyBlogStudy(options: DailyBlogStudyOptions = {}): Promise<BlogStudy | undefined> {
  const now = options.now ?? Date.now();
  const requester = options.requester ?? fetch;
  const wait = options.wait ?? delay;
  const pillar = blogTopicPillarForDate(now);
  const ids = await searchPubMed(pillar.query, requester, wait);
  const unused = ids.filter((id) => !options.usedSourceIds?.has(id));
  if (!unused.length) return undefined;

  for (let offset = 0; offset < unused.length; offset += PUBMED_BATCH_SIZE) {
    const studies = await fetchPubMedStudies(unused.slice(offset, offset + PUBMED_BATCH_SIZE), requester, wait);
    const study = studies.find((candidate) => candidate.abstract.length >= 240);
    if (study) return {
      ...study,
      pillar: pillar.id,
      pillarLabel: pillar.label,
      sourceUrl: `https://pubmed.ncbi.nlm.nih.gov/${study.sourceId}/`,
    };
  }
  return undefined;
}

export function blogTopicPillarForDate(now: number): (typeof PILLARS)[number] {
  const { year, month, day } = moscowDate(now);
  const dayOfYear = Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000);
  return PILLARS[dayOfYear % PILLARS.length]!;
}

async function searchPubMed(
  query: string,
  requester: typeof fetch,
  wait: (milliseconds: number) => Promise<void>,
): Promise<string[]> {
  const parameters = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmode: "json",
    retmax: "500",
    sort: "relevance",
    tool: "codex_telegram_assistant",
  });
  const response = await requestSource(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${parameters}`, requester, wait);
  const payload = await response.json() as { esearchresult?: { idlist?: unknown } };
  return Array.isArray(payload.esearchresult?.idlist)
    ? payload.esearchresult.idlist.filter((id): id is string => typeof id === "string" && /^\d+$/u.test(id))
    : [];
}

async function fetchPubMedStudies(
  ids: readonly string[],
  requester: typeof fetch,
  wait: (milliseconds: number) => Promise<void>,
): Promise<Array<Omit<BlogStudy, "pillar" | "pillarLabel" | "sourceUrl">>> {
  if (!ids.length) return [];
  const parameters = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    retmode: "xml",
    tool: "codex_telegram_assistant",
  });
  const response = await requestSource(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${parameters}`, requester, wait);
  return parsePubMedArticles(await response.text());
}

export function parsePubMedArticles(source: string): Array<Omit<BlogStudy, "pillar" | "pillarLabel" | "sourceUrl">> {
  return [...source.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/giu)].flatMap((match) => {
    const article = match[1] ?? "";
    const sourceId = cleanText(firstXmlValue(article, "PMID"));
    const title = cleanText(firstXmlValue(article, "ArticleTitle"));
    const abstract = [...article.matchAll(/<AbstractText(?:\s[^>]*)?>([\s\S]*?)<\/AbstractText>/giu)]
      .map((part) => cleanText(part[1] ?? "")).filter(Boolean).join(" ");
    if (!/^\d+$/u.test(sourceId) || !title || !abstract) return [];
    const publication = cleanText(firstXmlValue(article, "Title")) || undefined;
    const yearValue = firstXmlValue(article, "Year") || firstXmlValue(article, "MedlineDate").match(/\b(?:19|20)\d{2}\b/u)?.[0];
    const year = yearValue ? Number.parseInt(yearValue, 10) : undefined;
    return [{ sourceId, title, abstract: abstract.slice(0, 8_000), publication, year }];
  });
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
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) return response;
      const responseError = new Error(`PubMed HTTP ${response.status}`);
      lastError = responseError;
      if (!retryableStatus(response.status)) throw new NonRetryableSourceError(responseError.message);
    } catch (error) {
      if (error instanceof NonRetryableSourceError) throw error;
      lastError = error;
    }
    if (attempt < SOURCE_ATTEMPTS - 1) await wait(SOURCE_RETRY_DELAYS[attempt] ?? SOURCE_RETRY_DELAYS.at(-1)!);
  }
  throw lastError instanceof Error ? lastError : new Error("PubMed request failed");
}

class NonRetryableSourceError extends Error {}

function firstXmlValue(source: string, name: string): string {
  return source.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "iu"))?.[1] ?? "";
}

function cleanText(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/gu, " ")).replace(/[\u00a0\s]+/gu, " ").trim();
}

function decodeXml(value: string): string {
  return value.replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&nbsp;", " ").replaceAll("&quot;", "\"").replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function moscowDate(now: number): { year: number; month: number; day: number } {
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
