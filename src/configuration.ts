import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type ApprovalPolicy = "never" | "on-request" | "untrusted";
export type SandboxPreset = "read-only" | "workspace-write" | "danger-full-access";

export interface ExecutionProfile {
  id: string;
  title: string;
  sandbox: SandboxPreset;
  approvals: ApprovalPolicy;
}

export interface AppConfiguration {
  telegramToken: string;
  allowedUsers: ReadonlySet<number>;
  transcriptionOnlyUsers: ReadonlySet<number>;
  homeDirectory: string;
  dataDirectory: string;
  writingArchiveDirectory: string;
  memsearchExecutable: string;
  defaultWorkspace: string;
  projectAliases: Readonly<Record<string, string>>;
  weatherLocation: string;
  weatherLatitude: number;
  weatherLongitude: number;
  mediaDownloaderExecutable: string;
  ffmpegExecutable: string;
  mediaSummaryMaxDurationSeconds: number;
  mediaCookiesFromBrowser?: string;
  mediaCookiesFile?: string;
  whisperPython?: string;
  whisperModel?: string;
  defaultModel?: string;
  defaultProfile: string;
  profiles: readonly ExecutionProfile[];
  maxUploadBytes: number;
  showUsage: boolean;
}

export function readConfiguration(cwd = process.cwd(), environment: NodeJS.ProcessEnv = process.env): AppConfiguration {
  const env = { ...readDotEnv(path.join(cwd, ".env")), ...environment };
  const telegramToken = required(env, "TELEGRAM_BOT_TOKEN");
  const allowedUsers = new Set(parsePositiveIntegers(required(env, "TELEGRAM_ALLOWED_USER_IDS"), "TELEGRAM_ALLOWED_USER_IDS"));
  const transcriptionOnlyUsers = new Set(parseOptionalPositiveIntegers(
    env.TELEGRAM_TRANSCRIPTION_ONLY_USER_IDS, "TELEGRAM_TRANSCRIPTION_ONLY_USER_IDS",
  ));
  const overlappingUser = [...transcriptionOnlyUsers].find((userId) => allowedUsers.has(userId));
  if (overlappingUser !== undefined) {
    throw new Error(`Telegram user ${overlappingUser} cannot have both full and transcription-only access`);
  }
  const homeDirectory = env.HOME?.trim() || cwd;
  const defaultWorkspace = path.resolve(env.ASSISTANT_WORKSPACE?.trim() || cwd);
  const dataDirectory = path.resolve(env.ASSISTANT_DATA_DIR?.trim() || path.join(homeDirectory, ".local", "share", "codex-telegram-assistant"));
  const profiles = parseProfiles(env.ASSISTANT_PROFILES_JSON);
  const defaultProfile = env.ASSISTANT_DEFAULT_PROFILE?.trim() || "default";
  if (!profiles.some((profile) => profile.id === defaultProfile)) {
    throw new Error(`Unknown ASSISTANT_DEFAULT_PROFILE: ${defaultProfile}`);
  }
  const mediaCookiesFromBrowser = optional(env.MEDIA_COOKIES_FROM_BROWSER);
  const mediaCookiesFile = optional(env.MEDIA_COOKIES_FILE);
  if (mediaCookiesFromBrowser && mediaCookiesFile) {
    throw new Error("Set only one of MEDIA_COOKIES_FROM_BROWSER and MEDIA_COOKIES_FILE");
  }
  return {
    telegramToken,
    allowedUsers,
    transcriptionOnlyUsers,
    homeDirectory,
    dataDirectory,
    writingArchiveDirectory: path.resolve(env.WRITING_ARCHIVE_DIR?.trim() || path.join(homeDirectory, "Documents", "Codex Writer")),
    memsearchExecutable: path.resolve(env.MEMSEARCH_BIN?.trim() || path.join(homeDirectory, ".local", "bin", "memsearch")),
    defaultWorkspace,
    projectAliases: parseAliases(env.PROJECT_ALIASES_JSON || env.WORKSPACE_LABELS_JSON),
    weatherLocation: optional(env.WEATHER_LOCATION) || "Москва",
    weatherLatitude: parseCoordinate(env.WEATHER_LATITUDE, 55.7558, -90, 90, "WEATHER_LATITUDE"),
    weatherLongitude: parseCoordinate(env.WEATHER_LONGITUDE, 37.6173, -180, 180, "WEATHER_LONGITUDE"),
    mediaDownloaderExecutable: optional(env.MEDIA_DOWNLOADER_BIN) || "yt-dlp",
    ffmpegExecutable: optional(env.FFMPEG_BIN) || "ffmpeg",
    mediaSummaryMaxDurationSeconds: parsePositiveInteger(env.MEDIA_SUMMARY_MAX_DURATION_SECONDS, 6 * 60 * 60,
      "MEDIA_SUMMARY_MAX_DURATION_SECONDS"),
    mediaCookiesFromBrowser,
    mediaCookiesFile: mediaCookiesFile ? path.resolve(mediaCookiesFile) : undefined,
    whisperPython: optional(env.WHISPER_PYTHON),
    whisperModel: optional(env.WHISPER_MODEL),
    defaultModel: optional(env.CODEX_MODEL),
    defaultProfile,
    profiles,
    maxUploadBytes: parseByteLimit(env.MAX_UPLOAD_BYTES || env.MAX_FILE_SIZE),
    showUsage: parseBoolean(env.SHOW_TURN_USAGE || env.SHOW_TURN_TOKEN_USAGE, false),
  };
}

function readDotEnv(file: string): NodeJS.ProcessEnv {
  if (!existsSync(file)) return {};
  const result: NodeJS.ProcessEnv = {};
  for (const sourceLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator < 1) continue;
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value.replaceAll("\\n", "\n");
  }
  return result;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = optional(env[key]);
  if (!value) throw new Error(`Missing required setting: ${key}`);
  return value;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parsePositiveIntegers(value: string, key: string): number[] {
  const result = value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0);
  if (!result.length) throw new Error(`${key} must contain a positive integer`);
  return result;
}

function parseOptionalPositiveIntegers(value: string | undefined, key: string): number[] {
  const normalized = optional(value);
  return normalized ? parsePositiveIntegers(normalized, key) : [];
}

function parseAliases(value: string | undefined): Readonly<Record<string, string>> {
  if (!optional(value)) return {};
  const parsed = JSON.parse(value!) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PROJECT_ALIASES_JSON must be an object");
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function parseProfiles(value: string | undefined): readonly ExecutionProfile[] {
  if (!optional(value)) {
    return [
      { id: "default", title: "Default", sandbox: "workspace-write", approvals: "never" },
      { id: "review", title: "Review", sandbox: "workspace-write", approvals: "on-request" },
      { id: "readonly", title: "Read only", sandbox: "read-only", approvals: "never" },
    ];
  }
  const parsed = JSON.parse(value!) as unknown;
  if (!Array.isArray(parsed)) throw new Error("ASSISTANT_PROFILES_JSON must be an array");
  return parsed.map((row, index) => {
    if (!row || typeof row !== "object") throw new Error(`Invalid execution profile at index ${index}`);
    const item = row as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.title !== "string") throw new Error(`Invalid execution profile at index ${index}`);
    if (!isSandbox(item.sandbox) || !isApprovals(item.approvals)) throw new Error(`Invalid execution profile at index ${index}`);
    return { id: item.id, title: item.title, sandbox: item.sandbox, approvals: item.approvals };
  });
}

function isSandbox(value: unknown): value is SandboxPreset {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function isApprovals(value: unknown): value is ApprovalPolicy {
  return value === "never" || value === "on-request" || value === "untrusted";
}

function parseByteLimit(value: string | undefined): number {
  const parsed = Number(value ?? 20 * 1024 * 1024);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("MAX_UPLOAD_BYTES must be a positive integer");
  return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number, key: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  throw new Error(`Invalid boolean: ${value}`);
}

function parseCoordinate(value: string | undefined, fallback: number, minimum: number, maximum: number, key: string): number {
  if (!optional(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid ${key}`);
  return parsed;
}
