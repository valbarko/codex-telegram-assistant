import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { transcribeAudioBatchDetailed, type AudioTranscript } from "./audio.js";
import type { AppConfiguration } from "./configuration.js";
import { EphemeralTextEditor } from "./ephemeral-text-editor.js";
import { transcribeWithFluidAudioDetailed } from "./fluid-audio.js";
import type { AssistantDatabase, MediaJobCheckpoint } from "./storage.js";

const execute = promisify(execFile);
const CHUNK_SECONDS = 30 * 60;
const COMMAND_TIMEOUT_MS = 30 * 60_000;
export const MEDIA_FORMAT_SELECTOR = "bestaudio[abr<=96]/bestaudio/best[height<=144]/best[height<=240]/best";

const SUPPORTED_MEDIA_HOSTS = [
  "youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
  "rutube.ru",
  "vk.com",
  "vk.ru",
  "vkvideo.ru",
] as const;

export interface MediaSummaryProgress {
  stage: "inspect" | "download" | "prepare" | "transcribe" | "summarize";
  current?: number;
  total?: number;
}

export interface MediaSummaryResult {
  title?: string;
  durationSeconds?: number;
  markdown: string;
}

export interface MediaCaptionTrack {
  language: string;
  automatic: boolean;
}

interface MediaInfo {
  title?: string;
  durationSeconds?: number;
  caption?: MediaCaptionTrack;
}

type MediaSummaryConfiguration = Pick<AppConfiguration,
  "dataDirectory" | "defaultModel" | "mediaDownloaderExecutable" | "ffmpegExecutable" | "fluidAudioExecutable"
  | "mediaSummaryMaxDurationSeconds"
  | "mediaCookiesFromBrowser" | "mediaCookiesFile" | "whisperPython" | "whisperModel">;

type ProgressCallback = (progress: MediaSummaryProgress) => void | Promise<void>;

export class MediaSummaryService {
  private readonly editor: EphemeralTextEditor;

  constructor(private readonly configuration: MediaSummaryConfiguration,
    private readonly database?: AssistantDatabase, editor?: EphemeralTextEditor) {
    this.editor = editor ?? new EphemeralTextEditor(configuration);
  }

  async summarize(sourceUrl: string, progress: ProgressCallback = () => undefined,
    jobId?: string): Promise<MediaSummaryResult> {
    const normalizedUrl = parseSupportedMediaUrl(sourceUrl);
    if (!normalizedUrl) throw new Error("Поддерживаются ссылки YouTube, RuTube и VK Видео");
    const persistent = Boolean(jobId && this.database);
    const directory = persistent ? this.jobDirectory(jobId!) : await mkdtemp(path.join(os.tmpdir(), "codex-media-summary-"));
    await mkdir(directory, { recursive: true });
    let checkpoint = persistent ? this.database!.mediaJobCheckpoint(jobId!) : undefined;
    if (checkpoint && checkpoint.sourceUrl !== normalizedUrl) throw new Error("Сохранённая медиазадача относится к другой ссылке");
    checkpoint ??= this.saveCheckpoint({
      jobId: jobId ?? path.basename(directory),
      sourceUrl: normalizedUrl,
      stage: "queued",
      chunks: [],
      transcriptParts: [],
    }, persistent);
    try {
      if (checkpoint.stage === "queued") {
        await progress({ stage: "inspect" });
        const inspected = await this.inspect(normalizedUrl);
        if (inspected.durationSeconds && inspected.durationSeconds > this.configuration.mediaSummaryMaxDurationSeconds) {
          throw new Error(`Видео длиннее допустимого лимита ${formatDuration(this.configuration.mediaSummaryMaxDurationSeconds)}`);
        }
        checkpoint = this.saveCheckpoint({
          ...checkpoint,
          stage: "inspected",
          title: inspected.title,
          durationSeconds: inspected.durationSeconds,
          captionLanguage: inspected.caption?.language,
        }, persistent);
      }

      if (checkpoint.captionLanguage && !checkpoint.transcriptParts[0]) {
        await progress({ stage: "download" });
        try {
          const transcript = await this.downloadCaption(normalizedUrl, checkpoint.captionLanguage, directory);
          checkpoint = this.saveCheckpoint({
            ...checkpoint,
            stage: "transcribed",
            transcriptParts: [transcript],
          }, persistent);
        } catch (error) {
          console.warn("Caption download failed; falling back to audio transcription", error);
          checkpoint = this.saveCheckpoint({ ...checkpoint, captionLanguage: undefined }, persistent);
        }
      }

      if (!checkpoint.captionLanguage) {
        if (!checkpoint.mediaPath || !existsSync(checkpoint.mediaPath)) {
          await progress({ stage: "download" });
          const mediaPath = await this.download(normalizedUrl, directory);
          checkpoint = this.saveCheckpoint({ ...checkpoint, stage: "downloaded", mediaPath }, persistent);
        }

        if (shouldUseFluidAudio(checkpoint.chunks, checkpoint.transcriptParts)) {
          checkpoint = this.saveCheckpoint({ ...checkpoint, stage: "transcribing" }, persistent);
          await progress({ stage: "transcribe", current: 1, total: 1 });
          try {
            const result = await transcribeWithFluidAudioDetailed(checkpoint.mediaPath!, {
              executable: this.configuration.fluidAudioExecutable,
              language: "ru",
              timeoutMs: COMMAND_TIMEOUT_MS,
            });
            checkpoint = this.saveCheckpoint({
              ...checkpoint,
              stage: "transcribed",
              transcriptParts: [formatTimestampedTranscript(result)],
            }, persistent);
          } catch (error) {
            console.warn("FluidAudio transcription failed; falling back to MLX Whisper", error);
          }
        }

        if (checkpoint.chunks.length || !hasTranscript(checkpoint.transcriptParts)) {
          if (!checkpoint.chunks.length || checkpoint.chunks.some((chunk) => !existsSync(chunk))) {
            await progress({ stage: "prepare" });
            const chunks = await this.splitAudio(checkpoint.mediaPath!, directory);
            const existingParts = checkpoint.transcriptParts;
            checkpoint = this.saveCheckpoint({
              ...checkpoint,
              stage: "prepared",
              chunks,
              transcriptParts: chunks.map((_, index) => existingParts[index] ?? null),
            }, persistent);
          }
          const pending = checkpoint.chunks.map((file, index) => ({ file, index }))
            .filter(({ index }) => !checkpoint!.transcriptParts[index]);
          if (pending.length) {
            checkpoint = this.saveCheckpoint({ ...checkpoint, stage: "transcribing" }, persistent);
            await progress({ stage: "transcribe", current: pending[0]!.index + 1, total: checkpoint.chunks.length });
            await transcribeAudioBatchDetailed(pending.map(({ file }) => file), {
              language: null,
              python: this.configuration.whisperPython,
              model: this.configuration.whisperModel,
              onResult: async (result, pendingIndex) => {
                const originalIndex = pending[pendingIndex]!.index;
                const parts = [...checkpoint!.transcriptParts];
                parts[originalIndex] = formatTimestampedTranscript(result, originalIndex * CHUNK_SECONDS);
                checkpoint = this.saveCheckpoint({ ...checkpoint!, stage: "transcribing", transcriptParts: parts }, persistent);
                const next = pending[pendingIndex + 1];
                if (next) await progress({ stage: "transcribe", current: next.index + 1, total: checkpoint!.chunks.length });
              },
            });
            checkpoint = this.saveCheckpoint({ ...checkpoint, stage: "transcribed" }, persistent);
          }
        }
      }

      const transcript = checkpoint.transcriptParts.filter((part): part is string => Boolean(part)).join("\n");
      if (!transcript.trim()) throw new Error("Распознавание не вернуло текст из видео");
      await progress({ stage: "summarize" });
      const markdown = await this.editor.summarizeMediaTranscript({
        title: checkpoint.title,
        url: normalizedUrl,
        durationSeconds: checkpoint.durationSeconds,
        transcript,
      });
      return { title: checkpoint.title, durationSeconds: checkpoint.durationSeconds, markdown };
    } finally {
      if (!persistent) await rm(directory, { recursive: true, force: true });
    }
  }

  async cleanup(jobId: string): Promise<void> {
    if (!this.database) return;
    const directory = this.jobDirectory(jobId);
    await rm(directory, { recursive: true, force: true });
    this.database.deleteMediaJobCheckpoint(jobId);
  }

  private async inspect(sourceUrl: string): Promise<MediaInfo> {
    const { stdout } = await this.command(this.configuration.mediaDownloaderExecutable, [
      "--dump-single-json",
      "--skip-download",
      "--no-playlist",
      "--no-mark-watched",
      "--no-warnings",
      ...this.authenticationArguments(),
      sourceUrl,
    ], "Не удалось получить сведения о видео");
    const parsed = parseJsonOutput(stdout) as Record<string, unknown>;
    if (parsed.is_live === true || parsed.live_status === "is_live") throw new Error("Прямые эфиры пока не поддерживаются");
    const title = typeof parsed.title === "string" ? parsed.title.trim() || undefined : undefined;
    const durationSeconds = typeof parsed.duration === "number" && Number.isFinite(parsed.duration) && parsed.duration > 0
      ? parsed.duration : undefined;
    return { title, durationSeconds, caption: selectCaptionTrack(parsed) };
  }

  private async download(sourceUrl: string, directory: string): Promise<string> {
    const outputTemplate = path.join(directory, "source.%(ext)s");
    const { stdout } = await this.command(this.configuration.mediaDownloaderExecutable, [
      "--no-playlist",
      "--no-mark-watched",
      "--no-warnings",
      "--no-progress",
      "--format", MEDIA_FORMAT_SELECTOR,
      "--extract-audio",
      "--audio-format", "best",
      "--output", outputTemplate,
      "--print", "after_move:%(filepath)s",
      ...this.authenticationArguments(),
      sourceUrl,
    ], "Не удалось скачать аудиодорожку");
    const candidate = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
    if (!candidate) throw new Error("yt-dlp не сообщил путь к аудиодорожке");
    const resolved = path.resolve(candidate);
    const root = `${path.resolve(directory)}${path.sep}`;
    if (!resolved.startsWith(root) || !existsSync(resolved)) throw new Error("yt-dlp не создал ожидаемый аудиофайл");
    return resolved;
  }

  private async downloadCaption(sourceUrl: string, language: string, directory: string): Promise<string> {
    const outputTemplate = path.join(directory, "captions.%(ext)s");
    await this.command(this.configuration.mediaDownloaderExecutable, [
      "--skip-download",
      "--no-playlist",
      "--no-mark-watched",
      "--no-warnings",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs", language,
      "--sub-format", "json3/vtt/srt/best",
      "--output", outputTemplate,
      ...this.authenticationArguments(),
      sourceUrl,
    ], "Не удалось скачать субтитры");
    const names = (await readdir(directory)).filter((name) => name.startsWith("captions.") && /\.(?:json3|vtt|srt)$/iu.test(name));
    const name = names.sort((left, right) => captionFormatRank(left) - captionFormatRank(right))[0];
    if (!name) throw new Error("yt-dlp не создал файл субтитров");
    const file = path.join(directory, name);
    const transcript = parseCaptionTranscript(await readFile(file, "utf8"), path.extname(file).slice(1));
    if (!transcript.trim()) throw new Error("Субтитры не содержат текста");
    return transcript;
  }

  private async splitAudio(mediaFile: string, directory: string): Promise<string[]> {
    const chunksDirectory = path.join(directory, "chunks");
    await mkdir(chunksDirectory, { recursive: true });
    const target = path.join(chunksDirectory, "chunk-%04d.mka");
    await this.command(this.configuration.ffmpegExecutable, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-i", mediaFile,
      "-map", "0:a:0", "-vn", "-c:a", "copy",
      "-f", "segment", "-segment_time", String(CHUNK_SECONDS), "-reset_timestamps", "1",
      target,
    ], "Не удалось подготовить аудио");
    const chunks = (await readdir(chunksDirectory)).filter((name) => /^chunk-\d{4}\.mka$/.test(name)).sort()
      .map((name) => path.join(chunksDirectory, name));
    if (!chunks.length) throw new Error("ffmpeg не создал аудиофрагменты");
    return chunks;
  }

  private async command(executable: string, args: readonly string[], label: string): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execute(executable, [...args], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      const value = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      if (value.code === "ENOENT") {
        const tool = path.basename(executable);
        const install = tool.includes("yt-dlp") ? "brew install yt-dlp" : tool.includes("ffmpeg") ? "brew install ffmpeg" : undefined;
        throw new Error(`${tool} не найден${install ? `. Установите: ${install}` : ""}`);
      }
      if (/sign in to confirm you(?:'|’)re not a bot/i.test(value.stderr ?? "")) {
        throw new Error("YouTube запросил проверку браузера. Настройте MEDIA_COOKIES_FROM_BROWSER или MEDIA_COOKIES_FILE");
      }
      const detail = lastUsefulLine(value.stderr) || lastUsefulLine(value.message);
      throw new Error(detail ? `${label}: ${detail}` : label);
    }
  }

  private authenticationArguments(): string[] {
    if (this.configuration.mediaCookiesFile) return ["--cookies", this.configuration.mediaCookiesFile];
    if (this.configuration.mediaCookiesFromBrowser) return ["--cookies-from-browser", this.configuration.mediaCookiesFromBrowser];
    return [];
  }

  private saveCheckpoint(checkpoint: Omit<MediaJobCheckpoint, "createdAt" | "changedAt"> | MediaJobCheckpoint,
    persistent: boolean): MediaJobCheckpoint {
    if (persistent) {
      const { createdAt: _createdAt, changedAt: _changedAt, ...value } = checkpoint as MediaJobCheckpoint;
      return this.database!.saveMediaJobCheckpoint(value);
    }
    const now = Date.now();
    return { ...checkpoint, createdAt: "createdAt" in checkpoint ? checkpoint.createdAt : now, changedAt: now };
  }

  private jobDirectory(jobId: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(jobId)) throw new Error("Некорректный идентификатор медиазадачи");
    return path.join(this.configuration.dataDirectory, "media-jobs", jobId);
  }
}

export function parseSupportedMediaUrl(value: string): string | undefined {
  const source = value.trim();
  if (!source || /\s/.test(source)) return undefined;
  try {
    const url = new URL(source);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!SUPPORTED_MEDIA_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function formatTimestampedTranscript(result: AudioTranscript, offsetSeconds = 0): string {
  if (!result.segments.length) return `[${formatTimestamp(offsetSeconds)}] ${result.text.trim()}`;
  return result.segments.map((segment) => `[${formatTimestamp(offsetSeconds + segment.start)}] ${segment.text}`).join("\n");
}

export function shouldUseFluidAudio(chunks: readonly string[], transcriptParts: readonly (string | null)[]): boolean {
  return chunks.length === 0 && !hasTranscript(transcriptParts);
}

export function formatTimestamp(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

export function selectCaptionTrack(value: Record<string, unknown>): MediaCaptionTrack | undefined {
  const manual = availableCaptionLanguages(value.subtitles);
  if (manual.length) return { language: preferredCaptionLanguage(manual, false), automatic: false };
  const automatic = availableCaptionLanguages(value.automatic_captions);
  if (automatic.length) return { language: preferredCaptionLanguage(automatic, true), automatic: true };
  return undefined;
}

export function parseCaptionTranscript(source: string, format: string): string {
  const cues: Array<{ startSeconds: number; text: string }> = [];
  if (format.toLowerCase() === "json3") {
    const parsed = JSON.parse(source) as { events?: unknown };
    if (!Array.isArray(parsed.events)) return "";
    for (const event of parsed.events) {
      if (!event || typeof event !== "object") continue;
      const item = event as { tStartMs?: unknown; segs?: unknown };
      if (!Array.isArray(item.segs)) continue;
      const text = normalizeCaptionText(item.segs.map((segment) => {
        if (!segment || typeof segment !== "object") return "";
        const utf8 = (segment as { utf8?: unknown }).utf8;
        return typeof utf8 === "string" ? utf8 : "";
      }).join(""));
      if (text) appendCaptionCue(cues, Number(item.tStartMs) / 1000, text);
    }
  } else {
    for (const block of source.replace(/^\uFEFF/u, "").split(/\r?\n\s*\r?\n/u)) {
      const lines = block.split(/\r?\n/u).map((line) => line.trim());
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) continue;
      const start = parseCaptionTimestamp(lines[timingIndex]!.split("-->")[0]!.trim());
      const text = normalizeCaptionText(lines.slice(timingIndex + 1).join(" "));
      if (Number.isFinite(start) && text) appendCaptionCue(cues, start, text);
    }
  }
  return cues.map((cue) => `[${formatTimestamp(cue.startSeconds)}] ${cue.text}`).join("\n");
}

function availableCaptionLanguages(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, tracks]) => Array.isArray(tracks) && tracks.some((track) => {
      if (!track || typeof track !== "object") return false;
      const candidate = track as { url?: unknown; data?: unknown };
      return typeof candidate.url === "string" || typeof candidate.data === "string";
    }))
    .map(([language]) => language);
}

function hasTranscript(parts: readonly (string | null)[]): boolean {
  return parts.some((part) => Boolean(part?.trim()));
}

function preferredCaptionLanguage(languages: readonly string[], automatic: boolean): string {
  const score = (language: string): number => {
    const normalized = language.toLowerCase();
    if (automatic && normalized.endsWith("-orig")) return 0;
    if (normalized === "ru" || normalized.startsWith("ru-")) return 1;
    if (!automatic && normalized.endsWith("-orig")) return 2;
    if (normalized === "en" || normalized.startsWith("en-")) return 3;
    return 4;
  };
  return [...languages].sort((left, right) => score(left) - score(right) || left.localeCompare(right))[0]!;
}

function normalizeCaptionText(value: string): string {
  return value
    .replace(/<\/?c(?:\.[^>]*)?>/giu, "")
    .replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/gu, "")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#(?:39|x27);/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function appendCaptionCue(cues: Array<{ startSeconds: number; text: string }>, startSeconds: number, text: string): void {
  const start = Number.isFinite(startSeconds) && startSeconds >= 0 ? startSeconds : 0;
  const previous = cues.at(-1);
  if (previous && start - previous.startSeconds <= 8) {
    if (text === previous.text || previous.text.startsWith(text)) return;
    if (text.startsWith(previous.text)) {
      previous.text = text;
      return;
    }
  }
  cues.push({ startSeconds: start, text });
}

function parseCaptionTimestamp(value: string): number {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/u.exec(value);
  if (!match) return Number.NaN;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function captionFormatRank(name: string): number {
  return name.endsWith(".json3") ? 0 : name.endsWith(".vtt") ? 1 : 2;
}

function formatDuration(value: number): string {
  const hours = Math.floor(value / 3600);
  const minutes = Math.ceil((value % 3600) / 60);
  return hours ? `${hours} ч ${minutes ? `${minutes} мин` : ""}`.trim() : `${minutes} мин`;
}

function parseJsonOutput(stdout: string): unknown {
  const source = stdout.trim();
  if (!source) throw new Error("yt-dlp вернул пустой ответ");
  try {
    return JSON.parse(source);
  } catch {
    for (const line of source.split(/\r?\n/).reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        // Continue to the previous line: yt-dlp can occasionally prepend a non-JSON notice.
      }
    }
    throw new Error("Не удалось разобрать сведения о видео");
  }
}

function lastUsefulLine(value: string | undefined): string | undefined {
  return value?.replace(/\u001B\[[0-9;]*m/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 500);
}
