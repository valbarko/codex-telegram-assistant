import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "codex-telegram-assistant.telegram-reader";

type TelegramReaderCredentialName = "api-id" | "api-hash" | "database-key";

export interface TelegramReaderCredentials {
  apiId: number;
  apiHash: string;
  databaseEncryptionKey: string;
}

export async function loadTelegramReaderCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TelegramReaderCredentials | undefined> {
  const apiIdSource = environment.TELEGRAM_READER_API_ID?.trim() || await readCredential("api-id");
  const apiHash = environment.TELEGRAM_READER_API_HASH?.trim() || await readCredential("api-hash");
  const databaseEncryptionKey = environment.TELEGRAM_READER_DATABASE_KEY?.trim()
    || await readCredential("database-key");
  if (!apiIdSource && !apiHash && !databaseEncryptionKey) return undefined;
  if (!apiIdSource || !apiHash || !databaseEncryptionKey) {
    throw new Error("Telegram reader credentials are incomplete");
  }
  return validateTelegramReaderCredentials({ apiId: Number(apiIdSource), apiHash, databaseEncryptionKey });
}

export async function saveTelegramReaderCredentials(apiId: string, apiHash: string): Promise<TelegramReaderCredentials> {
  if (process.platform !== "darwin") throw new Error("Telegram reader credential setup currently requires macOS Keychain");
  const credentials = validateTelegramReaderCredentials({
    apiId: Number(apiId.trim()),
    apiHash: apiHash.trim(),
    databaseEncryptionKey: randomBytes(32).toString("base64"),
  });
  await writeCredential("api-id", String(credentials.apiId));
  await writeCredential("api-hash", credentials.apiHash);
  await writeCredential("database-key", credentials.databaseEncryptionKey);
  return credentials;
}

export function validateTelegramReaderCredentials(credentials: TelegramReaderCredentials): TelegramReaderCredentials {
  if (!Number.isSafeInteger(credentials.apiId) || credentials.apiId < 1) {
    throw new Error("Telegram API ID must be a positive integer");
  }
  if (!/^[a-f\d]{32}$/iu.test(credentials.apiHash)) {
    throw new Error("Telegram API hash must contain 32 hexadecimal characters");
  }
  const decoded = Buffer.from(credentials.databaseEncryptionKey, "base64");
  if (decoded.length < 32) throw new Error("Telegram database encryption key is invalid");
  return credentials;
}

async function readCredential(account: TelegramReaderCredentialName): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const result = await execFileAsync("security", [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w",
    ], { encoding: "utf8", maxBuffer: 16 * 1024 });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function writeCredential(account: TelegramReaderCredentialName, value: string): Promise<void> {
  try {
    await execFileAsync("security", [
      "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value,
    ], { encoding: "utf8", maxBuffer: 16 * 1024 });
  } catch {
    throw new Error(`Failed to save Telegram reader credential: ${account}`);
  }
}
