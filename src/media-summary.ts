import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { transcribeAudioDetailed, type AudioTranscript } from "./audio.js";
import type { AppConfiguration } from "./configuration.js";
import { EphemeralTextEditor } from "./ephemeral-text-editor.js";

const execute = promisify(execFile);
const CHUNK_SECONDS = 30 * 60;
const COMMAND_TIMEOUT_MS = 30 * 60_000;

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

interface MediaInfo {
  title?: string;
  durationSeconds?: number;
}

type MediaSummaryConfiguration = Pick<AppConfiguration,
  "defaultModel" | "mediaDownloaderExecutable" | "ffmpegExecutable" | "mediaSummaryMaxDurationSeconds"
  | "mediaCookiesFromBrowser" | "mediaCookiesFile" | "whisperPython" | "whisperModel">;

type ProgressCallback = (progress: MediaSummaryProgress) => void | Promise<void>;

export class MediaSummaryService {
  private readonly editor: EphemeralTextEditor;

  constructor(private readonly configuration: MediaSummaryConfiguration, editor?: EphemeralTextEditor) {
    this.editor = editor ?? new EphemeralTextEditor(configuration);
  }

  async summarize(sourceUrl: string, progress: ProgressCallback = () => undefined): Promise<MediaSummaryResult> {
    const normalizedUrl = parseSupportedMediaUrl(sourceUrl);
    if (!normalizedUrl) throw new Error("Поддерживаются ссылки YouTube, RuTube и VK Видео");
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-media-summary-"));
    try {
      await progress({ stage: "inspect" });
      const info = await this.inspect(normalizedUrl);
      if (info.durationSeconds && info.durationSeconds > this.configuration.mediaSummaryMaxDurationSeconds) {
        throw new Error(`Видео длиннее допустимого лимита ${formatDuration(this.configuration.mediaSummaryMaxDurationSeconds)}`);
      }
      await progress({ stage: "download" });
      const mediaFile = await this.download(normalizedUrl, directory);
      await progress({ stage: "prepare" });
      const chunks = await this.splitAudio(mediaFile, directory);
      const transcriptParts: string[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        await progress({ stage: "transcribe", current: index + 1, total: chunks.length });
        const result = await transcribeAudioDetailed(chunks[index]!, {
          language: null,
          python: this.configuration.whisperPython,
          model: this.configuration.whisperModel,
        });
        transcriptParts.push(formatTimestampedTranscript(result, index * CHUNK_SECONDS));
      }
      const transcript = transcriptParts.filter(Boolean).join("\n");
      if (!transcript.trim()) throw new Error("Whisper не вернул текст из видео");
      await progress({ stage: "summarize" });
      const markdown = await this.editor.summarizeMediaTranscript({
        title: info.title,
        url: normalizedUrl,
        durationSeconds: info.durationSeconds,
        transcript,
      });
      return { title: info.title, durationSeconds: info.durationSeconds, markdown };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    return { title, durationSeconds };
  }

  private async download(sourceUrl: string, directory: string): Promise<string> {
    const outputTemplate = path.join(directory, "source.%(ext)s");
    const { stdout } = await this.command(this.configuration.mediaDownloaderExecutable, [
      "--no-playlist",
      "--no-mark-watched",
      "--no-warnings",
      "--no-progress",
      "--extract-audio",
      "--audio-format", "m4a",
      "--audio-quality", "5",
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

  private async splitAudio(mediaFile: string, directory: string): Promise<string[]> {
    const chunksDirectory = path.join(directory, "chunks");
    await mkdir(chunksDirectory);
    const target = path.join(chunksDirectory, "chunk-%04d.flac");
    await this.command(this.configuration.ffmpegExecutable, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-i", mediaFile,
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac",
      "-f", "segment", "-segment_time", String(CHUNK_SECONDS), "-reset_timestamps", "1",
      target,
    ], "Не удалось подготовить аудио");
    const chunks = (await readdir(chunksDirectory)).filter((name) => /^chunk-\d{4}\.flac$/.test(name)).sort()
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

export function formatTimestamp(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
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
