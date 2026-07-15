import type { AppConfiguration } from "./configuration.js";

export type TelegramAccessMode = "full" | "transcription-only" | "denied";

type AccessConfiguration = Pick<AppConfiguration, "allowedUsers" | "transcriptionOnlyUsers">;
type TelegramTranscriptionUpdate = { message?: { voice?: unknown; audio?: unknown; text?: unknown } };

export function telegramAccessMode(configuration: AccessConfiguration, userId?: number): TelegramAccessMode {
  if (userId === undefined) return "denied";
  if (configuration.allowedUsers.has(userId)) return "full";
  if (configuration.transcriptionOnlyUsers.has(userId)) return "transcription-only";
  return "denied";
}

export function isTranscriptionMedia(update: TelegramTranscriptionUpdate): boolean {
  return Boolean(update.message?.voice || update.message?.audio);
}

export function isTranscriptionText(update: TelegramTranscriptionUpdate): boolean {
  return typeof update.message?.text === "string" && Boolean(update.message.text.trim());
}
