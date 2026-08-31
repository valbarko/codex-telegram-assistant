import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { transcribeWithFluidAudioDetailed } from "./fluid-audio.js";

const execute = promisify(execFile);
const DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo";

export interface TranscriptOrigin {
  sender?: string;
  sentAt?: number;
}

export type VoiceTranscriptSource = "direct" | "forwarded";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface AudioTranscript {
  text: string;
  segments: readonly TranscriptSegment[];
}

export type AudioTranscriptionEngine = "fluid-audio" | "mlx-whisper";

export interface DetailedAudioTranscript extends AudioTranscript {
  engine: AudioTranscriptionEngine;
}

export interface TranscriptionOptions {
  /** `null` enables Whisper language auto-detection. The default preserves the existing Russian voice-message behavior. */
  language?: string | null;
  timeoutMs?: number;
  python?: string;
  model?: string;
  fluidAudioExecutable?: string;
}

export interface BatchTranscriptionOptions extends TranscriptionOptions {
  onResult?: (result: AudioTranscript, index: number) => void | Promise<void>;
}

export async function transcribeAudio(file: string, options: TranscriptionOptions = {}): Promise<string> {
  return (await transcribeAudioDetailed(file, options)).text;
}

export async function transcribeAudioDetailed(file: string,
  options: TranscriptionOptions = {}): Promise<DetailedAudioTranscript> {
  const fluidAudioExecutable = options.fluidAudioExecutable?.trim();
  if (fluidAudioExecutable && options.language !== null) {
    try {
      const result = await transcribeWithFluidAudioDetailed(file, {
        executable: fluidAudioExecutable,
        language: options.language,
        timeoutMs: options.timeoutMs,
      });
      return { ...result, engine: "fluid-audio" };
    } catch (error) {
      console.warn("FluidAudio transcription failed; falling back to MLX Whisper", error);
    }
  }
  return { ...await transcribeWithMlxWhisperDetailed(file, options), engine: "mlx-whisper" };
}

async function transcribeWithMlxWhisperDetailed(file: string, options: TranscriptionOptions): Promise<AudioTranscript> {
  const localPython = path.join(process.cwd(), ".venv", "bin", "python");
  const python = options.python?.trim() || process.env.WHISPER_PYTHON?.trim() || (existsSync(localPython) ? localPython : "python3");
  const model = options.model?.trim() || process.env.WHISPER_MODEL?.trim() || DEFAULT_MODEL;
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
  return parseTranscriptPayload(JSON.parse(stdout.trim()));
}

export async function transcribeAudioBatchDetailed(files: readonly string[],
  options: BatchTranscriptionOptions = {}): Promise<AudioTranscript[]> {
  if (!files.length) return [];
  const localPython = path.join(process.cwd(), ".venv", "bin", "python");
  const python = options.python?.trim() || process.env.WHISPER_PYTHON?.trim() || (existsSync(localPython) ? localPython : "python3");
  const model = options.model?.trim() || process.env.WHISPER_MODEL?.trim() || DEFAULT_MODEL;
  const language = options.language === undefined ? "ru" : options.language;
  const program = [
    "import json,sys",
    "import mlx_whisper",
    "model=sys.argv[1]",
    "detected_language=sys.argv[2] or None",
    "for index,file in enumerate(sys.argv[3:]):",
    " result=mlx_whisper.transcribe(file,path_or_hf_repo=model,language=detected_language)",
    " if detected_language is None: detected_language=result.get('language')",
    " segments=[{'start':item.get('start',0),'end':item.get('end',0),'text':item.get('text','')} for item in result.get('segments',[])]",
    " print(json.dumps({'index':index,'text':result.get('text',''),'segments':segments},ensure_ascii=False),flush=True)",
  ].join("\n");
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const child = spawn(python, ["-c", program, model, language ?? "", ...files], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const results: AudioTranscript[] = [];
  let stderr = "";
  let settled = false;
  let timedOut = false;
  let timer: NodeJS.Timeout;
  let callbacks = Promise.resolve();
  const armTimeout = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref?.();
  };
  armTimeout();
  child.stderr.on("data", (data: Buffer) => {
    stderr = `${stderr}${data.toString("utf8")}`.slice(-16 * 1024);
  });
  lines.on("line", (line) => {
    armTimeout();
    callbacks = callbacks.then(async () => {
      const payload = JSON.parse(line) as { index?: unknown } & Record<string, unknown>;
      const index = Number(payload.index);
      if (!Number.isSafeInteger(index) || index !== results.length) throw new Error("Whisper вернул фрагменты в неожиданном порядке");
      const result = parseTranscriptPayload(payload);
      results.push(result);
      await options.onResult?.(result, index);
    });
  });
  return await new Promise<AudioTranscript[]>((resolve, reject) => {
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(error);
    };
    child.once("error", fail);
    child.once("close", (code, signal) => {
      void callbacks.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Whisper timeout after ${Math.ceil(timeoutMs / 60_000)} min without a completed fragment`));
          return;
        }
        if (code !== 0 || results.length !== files.length) {
          const detail = stderr.trim().split(/\r?\n/u).filter(Boolean).at(-1);
          reject(new Error(detail || `Whisper завершился преждевременно${signal ? ` (${signal})` : ""}`));
          return;
        }
        resolve(results);
      }).catch(fail);
    });
  });
}

function parseTranscriptPayload(value: unknown): AudioTranscript {
  const parsed = value as { text?: unknown; segments?: unknown };
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

export function formatVoiceTranscript(raw: string, source: VoiceTranscriptSource, origin: TranscriptOrigin = {}): string {
  return source === "forwarded" ? structureTranscript(raw, origin) : formatPlainTranscript(raw);
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
