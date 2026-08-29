import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { AudioTranscript } from "./audio.js";

const execute = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export interface FluidAudioTranscriptionOptions {
  executable: string;
  language?: string;
  timeoutMs?: number;
}

export async function transcribeWithFluidAudioDetailed(file: string,
  options: FluidAudioTranscriptionOptions): Promise<AudioTranscript> {
  const outputFile = path.join(path.dirname(file), `.fluid-transcript-${randomUUID()}.json`);
  try {
    await execute(options.executable, fluidAudioArguments(file, outputFile, options.language), {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseFluidAudioTranscript(JSON.parse(await readFile(outputFile, "utf8")));
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { stderr?: string };
    if (value.code === "ENOENT") throw new Error(`${path.basename(options.executable)} не найден`);
    const detail = lastUsefulLine(value.stderr) || lastUsefulLine(value.message);
    throw new Error(detail ? `FluidAudio не удалось распознать аудио: ${detail}` : "FluidAudio не удалось распознать аудио");
  } finally {
    await rm(outputFile, { force: true });
  }
}

export function fluidAudioArguments(mediaFile: string, outputFile: string, language = "ru"): string[] {
  return ["transcribe", mediaFile, "--model-version", "v3", "--language", language, "--output-json", outputFile];
}

export function parseFluidAudioTranscript(value: unknown): AudioTranscript {
  if (!value || typeof value !== "object") throw new Error("FluidAudio вернул некорректный результат");
  const parsed = value as { text?: unknown; wordTimings?: unknown };
  if (typeof parsed.text !== "string" || !parsed.text.trim()) throw new Error("FluidAudio вернул пустой текст");
  const words = Array.isArray(parsed.wordTimings)
    ? parsed.wordTimings.map(parseWord).filter((item): item is FluidAudioWord => Boolean(item))
    : [];
  return { text: parsed.text.trim(), segments: groupWords(words) };
}

interface FluidAudioWord {
  word: string;
  start: number;
  end: number;
}

function parseWord(value: unknown): FluidAudioWord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const word = typeof item.word === "string" ? item.word.replace(/\s+/gu, " ").trim() : "";
  const start = typeof item.startTime === "number" && Number.isFinite(item.startTime) ? Math.max(0, item.startTime) : undefined;
  const end = typeof item.endTime === "number" && Number.isFinite(item.endTime) ? Math.max(start ?? 0, item.endTime) : undefined;
  return word && start !== undefined && end !== undefined ? { word, start, end } : undefined;
}

function groupWords(words: readonly FluidAudioWord[]): AudioTranscript["segments"] {
  const result: Array<{ start: number; end: number; text: string }> = [];
  let group: FluidAudioWord[] = [];
  const flush = (): void => {
    if (!group.length) return;
    const text = group.map((item) => item.word).join(" ")
      .replace(/\s+([,.;:!?…])/gu, "$1").replace(/([«([{])\s+/gu, "$1").replace(/\s+([»\])}])/gu, "$1");
    result.push({ start: group[0]!.start, end: group.at(-1)!.end, text });
    group = [];
  };
  for (const word of words) {
    group.push(word);
    const duration = word.end - group[0]!.start;
    if ((/[.!?…][»"')\]}]*$/u.test(word.word) && duration >= 4) || duration >= 30 || group.length >= 60) flush();
  }
  flush();
  return result;
}

function lastUsefulLine(value: string | undefined): string | undefined {
  return value?.trim().split(/\r?\n/u).filter(Boolean).at(-1);
}
