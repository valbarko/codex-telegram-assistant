import { UnusableMediaTranscriptError } from "./media-transcript-quality.js";

export type MediaLanguage = "ru" | "en";
export interface MediaLanguageHint {
  language: MediaLanguage;
  source: "audio" | "text";
}

export function normalizeMediaLanguage(value: unknown): MediaLanguage | undefined {
  if (typeof value !== "string") return undefined;
  const language = value.toLowerCase().split(/[-_]/u)[0];
  return language === "ru" || language === "en" ? language : undefined;
}

/** A conservative RU/EN script check, not general-purpose language detection. */
export function inferMediaTextLanguage(value: string): MediaLanguage | undefined {
  const text = value.replace(/https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w.-]+/giu, "");
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 24) return undefined;
  const russian = text.match(/[а-яё]/giu)?.length ?? 0;
  const english = text.match(/[a-z]/giu)?.length ?? 0;
  if (russian / letters >= 0.9) return "ru";
  if (english / letters >= 0.9) return "en";
  return undefined;
}

export function inferMediaLanguageHint(value: Record<string, unknown>): MediaLanguageHint | undefined {
  // inspect() uses the same format selector as download(). Never infer from all available tracks.
  const downloads = records(value.requested_downloads);
  const selectedLevels = [downloads.flatMap((item) => records(item.requested_formats)),
    records(value.requested_formats), downloads];
  const trackLanguages = selectedLevels.map((selected) => selected.filter((item) => item.acodec !== "none")
    .flatMap((item) => typeof item.language === "string" && item.language.trim() ? [item.language] : []))
    .find((languages) => languages.length) ?? [];
  const explicit = trackLanguages.length ? trackLanguages
    : typeof value.language === "string" && value.language.trim() ? [value.language] : [];
  if (explicit.length) {
    const normalized = explicit.map(normalizeMediaLanguage);
    const language = normalized[0];
    // Unsupported or conflicting explicit languages must not turn into English via a Latin title.
    return language && normalized.every((item) => item === language) ? { language, source: "audio" } : undefined;
  }
  const title = typeof value.title === "string" ? value.title : "";
  const description = typeof value.description === "string" ? value.description.slice(0, 4000) : "";
  const titleLanguage = inferMediaTextLanguage(title);
  const descriptionLanguage = inferMediaTextLanguage(description);
  if (titleLanguage && descriptionLanguage && titleLanguage !== descriptionLanguage) return undefined;
  const language = titleLanguage ?? descriptionLanguage ?? inferMediaTextLanguage(`${title}\n${description}`);
  return language ? { language, source: "text" } : undefined;
}

export function mediaLanguageMismatch(value: string, hint?: MediaLanguageHint): boolean {
  const detected = inferMediaTextLanguage(value);
  return Boolean(hint && detected && hint.language !== detected);
}

export function assertMediaLanguage(value: string, hint?: MediaLanguageHint): void {
  if (mediaLanguageMismatch(value, hint)) {
    throw new UnusableMediaTranscriptError(`Media transcript language conflicts with ${hint!.source} hint (${hint!.language})`);
  }
}

export function parseMediaLanguageHint(value: unknown): MediaLanguageHint | undefined {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed && (parsed.language === "ru" || parsed.language === "en")
      && (parsed.source === "audio" || parsed.source === "text")) return parsed;
  } catch { /* Older or malformed checkpoints have no reliable hint. */ }
  return undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}
