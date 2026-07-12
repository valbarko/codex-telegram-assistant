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

export async function transcribeAudio(file: string): Promise<string> {
  const localPython = path.join(process.cwd(), ".venv", "bin", "python");
  const python = process.env.WHISPER_PYTHON?.trim() || (existsSync(localPython) ? localPython : "python3");
  const model = process.env.WHISPER_MODEL?.trim() || DEFAULT_MODEL;
  const program = [
    "import json,sys",
    "import mlx_whisper",
    "result=mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=sys.argv[2], language='ru')",
    "print(json.dumps({'text': result.get('text','')}, ensure_ascii=False))",
  ].join(";");
  const { stdout } = await execute(python, ["-c", program, file, model], { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout.trim()) as { text?: unknown };
  if (typeof parsed.text !== "string" || !parsed.text.trim()) throw new Error("Распознавание вернуло пустой текст");
  return parsed.text.trim();
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

function normalize(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function splitSentences(value: string): string[] { const result = value.match(/[^.!?]+[.!?]?/g)?.map((item) => item.trim()).filter(Boolean) ?? []; return result.length ? result : [value]; }
function isImportant(value: string): boolean { return /(?:^|[\s,.!?;:])(?:важно|решил|решила|решили|нужно|надо|будем|пауза|приостанов|договор|задач|итог|вывод|срок|план)[\p{L}\p{N}_-]*/iu.test(value); }
function distinct(values: string[]): string[] { return [...new Set(values)]; }
function group<T>(values: T[], size: number): T[][] { const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
function html(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function formatDate(value: number): string { return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Moscow" }).format(new Date(value)); }
