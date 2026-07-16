import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo";

export interface TranscriptOrigin {
  sender?: string;
  sentAt?: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface AudioTranscript {
  text: string;
  segments: readonly TranscriptSegment[];
}

export interface TranscriptionOptions {
  /** `null` enables Whisper language auto-detection. The default preserves the existing Russian voice-message behavior. */
  language?: string | null;
  timeoutMs?: number;
}

export async function transcribeAudio(file: string): Promise<string> {
  return (await transcribeAudioDetailed(file)).text;
}

export async function transcribeAudioDetailed(file: string, options: TranscriptionOptions = {}): Promise<AudioTranscript> {
  const localPython = path.join(process.cwd(), ".venv", "bin", "python");
  const python = process.env.WHISPER_PYTHON?.trim() || (existsSync(localPython) ? localPython : "python3");
  const model = process.env.WHISPER_MODEL?.trim() || DEFAULT_MODEL;
  const language = options.language === undefined ? "ru" : options.language;
  const program = [
    "import json,sys",
    "import mlx_whisper",
    "language=sys.argv[3] or None",
    "result=mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=sys.argv[2], language=language)",
    "segments=[{'start': item.get('start',0), 'end': item.get('end',0), 'text': item.get('text','')} for item in result.get('segments',[])]",
    "print(json.dumps({'text': result.get('text',''), 'segments': segments}, ensure_ascii=False))",
  ].join(";");
  const { stdout } = await execute(python, ["-c", program, file, model, language ?? ""], {
    timeout: options.timeoutMs ?? 30 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.trim()) as { text?: unknown; segments?: unknown };
  if (typeof parsed.text !== "string" || !parsed.text.trim()) throw new Error("Распознавание вернуло пустой текст");
  const segments = Array.isArray(parsed.segments) ? parsed.segments.map(parseSegment).filter((item): item is TranscriptSegment => Boolean(item)) : [];
  return { text: parsed.text.trim(), segments };
}

function parseSegment(value: unknown): TranscriptSegment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const start = typeof item.start === "number" && Number.isFinite(item.start) ? Math.max(0, item.start) : undefined;
  const end = typeof item.end === "number" && Number.isFinite(item.end) ? Math.max(start ?? 0, item.end) : undefined;
  const text = typeof item.text === "string" ? item.text.replace(/\s+/g, " ").trim() : "";
  return start === undefined || end === undefined || !text ? undefined : { start, end, text };
}

export function structureTranscript(raw: string, origin: TranscriptOrigin = {}): string {
  const text = normalize(raw);
  const sentences = splitSentences(text);
  const important = sentences.filter(isImportant);
  const summary = distinct([...(important.length ? important : sentences)].slice(0, 3));
  const metadata = [origin.sender ? `От: <b>${html(origin.sender)}</b>` : undefined, origin.sentAt ? formatDate(origin.sentAt) : undefined]
    .filter(Boolean).join(" · ");
  const paragraphs = group(sentences, 3).map((part) => part.map((sentence) => isImportant(sentence) ? `<b>${html(sentence)}</b>` : html(sentence)).join(" "));
  return [metadata || undefined, summary.length ? summary.map((sentence) => `• ${html(sentence)}`).join("\n") : undefined,
    "<b>Структурированная расшифровка</b>", ...paragraphs].filter((part): part is string => Boolean(part)).join("\n\n");
}

export function formatPlainTranscript(raw: string): string {
  const sourceParagraphs = raw.trim().split(/\n\s*\n+/).map(normalizePunctuation).filter(Boolean);
  const paragraphs = sourceParagraphs.flatMap((paragraph) => {
    const sentences = splitSentences(paragraph).map(polishSentence).filter(Boolean);
    return balancedParagraphs(sentences, 3).map((part) => part.join(" "));
  });
  return paragraphs.join("\n\n");
}

function normalize(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function splitSentences(value: string): string[] { const result = value.match(/[^.!?]+[.!?]?/g)?.map((item) => item.trim()).filter(Boolean) ?? []; return result.length ? result : [value]; }
function normalizePunctuation(value: string): string {
  return value.replace(/[\t\r\n ]+/g, " ").replace(/\s+([,.;:!?…])/g, "$1")
    .replace(/([,;:!?])(?=[\p{L}\p{N}])/gu, "$1 ").replace(/([.…])(?=\p{L})/gu, "$1 ")
    .replace(/([«(])\s+/g, "$1").replace(/\s+([»)])/g, "$1").trim();
}
function polishSentence(value: string): string {
  const normalized = normalizePunctuation(value);
  const capitalized = normalized.replace(/^([«"'([{—–-]*\s*)(\p{Ll})/u,
    (_match, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase("ru-RU")}`);
  return /[.!?…][»"')\]}]*$/u.test(capitalized) ? capitalized : `${capitalized}.`;
}
function balancedParagraphs<T>(values: T[], maximumSize: number): T[][] {
  if (!values.length) return [];
  const count = Math.ceil(values.length / maximumSize);
  const baseSize = Math.floor(values.length / count);
  let remainder = values.length % count;
  const result: T[][] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const size = baseSize + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    result.push(values.slice(offset, offset + size));
    offset += size;
  }
  return result;
}
function isImportant(value: string): boolean { return /(?:^|[\s,.!?;:])(?:важно|решил|решила|решили|нужно|надо|будем|пауза|приостанов|договор|задач|итог|вывод|срок|план)[\p{L}\p{N}_-]*/iu.test(value); }
function distinct(values: string[]): string[] { return [...new Set(values)]; }
function group<T>(values: T[], size: number): T[][] { const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
function html(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function formatDate(value: number): string { return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Moscow" }).format(new Date(value)); }
