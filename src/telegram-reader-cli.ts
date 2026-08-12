import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { chmod, readFile, rename, unlink } from "node:fs/promises";
import { promisify } from "node:util";

import QRCode from "qrcode";

import { readConfiguration } from "./configuration.js";
import {
  loadTelegramReaderCredentials,
  saveTelegramReaderCredentials,
  type TelegramReaderCredentials,
} from "./telegram-reader-keychain.js";
import {
  readTelegramReaderState,
  selectTelegramChannels,
  TelegramChannelReader,
  writeTelegramReaderState,
} from "./telegram-reader.js";
import { syncTelegramArticlePublications } from "./telegram-publication-sync.js";

const command = process.argv[2] || "status";
const configuration = readConfiguration();
const readerDirectory = path.join(configuration.dataDirectory, "telegram-reader");

if (command === "status") {
  const credentials = await loadTelegramReaderCredentials();
  const state = await readTelegramReaderState(readerDirectory);
  if (!credentials) console.log("Telegram account client: credentials are not configured");
  else if (!state) console.log("Telegram account client: credentials exist, account is not connected yet");
  else console.log(`Telegram account client: ${state.accountLabel}; mode: read/write; available channels: ${state.availableChannels.length}; reading allowed: ${state.allowedChannels.length}`);
  process.exit(0);
}

if (command === "connect-qr") {
  const credentials = await requiredCredentials();
  const reader = new TelegramChannelReader(credentials, readerDirectory);
  const qrFiles: string[] = [];
  let qrVersion = 0;
  try {
    const account = await reader.loginWithQr({
      onLink: async (link) => {
        const qrPath = path.join(readerDirectory, `telegram-login-qr-${Date.now()}-${qrVersion += 1}.png`);
        const temporary = `${qrPath}.${process.pid}.tmp.png`;
        await QRCode.toFile(temporary, link, { width: 520, margin: 3, errorCorrectionLevel: "M" });
        await chmod(temporary, 0o600);
        await rename(temporary, qrPath);
        qrFiles.push(qrPath);
        console.log(`QR_READY ${qrPath}`);
      },
      getPassword: async (hint, retry) => promptMacSecret([
        retry ? "Пароль не подошёл. Введите пароль 2FA Telegram ещё раз." : "Введите пароль двухэтапной аутентификации Telegram.",
        hint ? `Подсказка: ${hint}` : "",
      ].filter(Boolean).join("\n")),
    });
    const channels = await reader.listChannels();
    const previous = await readTelegramReaderState(readerDirectory);
    const availableIds = new Set(channels.map((channel) => channel.chatId));
    const allowedChannels = previous?.accountUserId === account.id
      ? previous.allowedChannels.filter((channel) => availableIds.has(channel.chatId)) : [];
    await writeTelegramReaderState(readerDirectory, {
      accountUserId: account.id,
      accountLabel: account.label,
      connectedAt: Date.now(),
      availableChannels: channels,
      allowedChannels,
    });
    console.log(`CONNECTED ${account.label} CHANNELS ${channels.length} ALLOWED ${allowedChannels.length}`);
  } finally {
    await reader.close();
    await Promise.all(qrFiles.map((file) => unlink(file).catch(() => undefined)));
  }
  process.exit(0);
}

if (command === "connect") {
  const credentials = await ensureCredentials();
  const reader = new TelegramChannelReader(credentials, readerDirectory);
  try {
    const account = await reader.login({
      getPhoneNumber: async (retry) => promptVisible(retry ? "Телефон ещё раз: " : "Телефон в международном формате: "),
      getEmailAddress: async () => promptVisible("Email для входа: "),
      getEmailCode: async () => promptHidden("Код из email: "),
      confirmOnAnotherDevice: (link) => console.log(`Подтверди вход в Telegram: ${link}`),
      getAuthCode: async (retry) => promptHidden(retry ? "Код Telegram ещё раз: " : "Код из Telegram: "),
      getPassword: async (hint, retry) => promptHidden(`${retry ? "Пароль 2FA ещё раз" : "Пароль 2FA"}${hint ? ` (${hint})` : ""}: `),
      getName: async () => ({ firstName: await promptVisible("Имя: "), lastName: await promptVisible("Фамилия: ") }),
    });
    console.log(`\nПодключён аккаунт: ${account.label}`);
    const channels = await reader.listChannels();
    console.log(`Найдено каналов: ${channels.length}\n`);
    channels.forEach((channel, index) => console.log(`${String(index + 1).padStart(3)}. ${channel.title}${channel.username ? ` · @${channel.username}` : ""}`));
    if (!channels.length) throw new Error("No subscribed Telegram channels found");
    console.log("\nЛичные чаты и группы в этот список не включены.");
    const selected = selectTelegramChannels(channels, await promptVisible("Номера каналов для чтения через запятую: "));
    await writeTelegramReaderState(readerDirectory, {
      accountUserId: account.id,
      accountLabel: account.label,
      connectedAt: Date.now(),
      availableChannels: channels,
      allowedChannels: selected,
    });
    console.log(`Разрешено каналов: ${selected.length}. Настройки сохранены локально.`);
  } finally {
    await reader.close();
  }
  process.exit(0);
}

if (command === "channels") {
  const state = await readTelegramReaderState(readerDirectory);
  if (!state) throw new Error("Run npm run telegram:connect-qr first");
  state.availableChannels.forEach((channel, index) => {
    const allowed = state.allowedChannels.some((candidate) => candidate.chatId === channel.chatId) ? "✓" : " ";
    console.log(`${allowed} ${String(index + 1).padStart(3)}. ${channel.title}${channel.username ? ` · @${channel.username}` : ""}`);
  });
  process.exit(0);
}

if (command === "allow") {
  const state = await readTelegramReaderState(readerDirectory);
  if (!state?.availableChannels.length) throw new Error("Run npm run telegram:connect-qr first");
  const source = process.argv.slice(3).join(" ").trim();
  const allowedChannels = selectTelegramChannels(state.availableChannels, source);
  await writeTelegramReaderState(readerDirectory, { ...state, allowedChannels });
  console.log(`Разрешено каналов: ${allowedChannels.length}`);
  process.exit(0);
}

if (command === "read") {
  const credentials = await requiredCredentials();
  const state = await readTelegramReaderState(readerDirectory);
  if (!state?.allowedChannels.length) throw new Error("Run npm run telegram:connect and choose channels first");
  const reader = new TelegramChannelReader(credentials, readerDirectory);
  try {
    await reader.login({});
    for (const channel of state.allowedChannels) {
      console.log(`\n## ${channel.title}${channel.username ? ` · @${channel.username}` : ""}`);
      const messages = await reader.readRecent(channel, 3);
      if (!messages.length) console.log("Нет недавних текстовых публикаций.");
      for (const message of messages) console.log(`- ${new Date(message.publishedAt).toLocaleString("ru-RU")}: ${shorten(message.text, 420)}`);
    }
  } finally {
    await reader.close();
  }
  process.exit(0);
}

if (command === "access") {
  const target = process.argv.slice(3).join(" ").trim();
  if (!target) throw new Error("Provide a channel username or chat identifier");
  const reader = new TelegramChannelReader(await requiredCredentials(), readerDirectory);
  try {
    await reader.login({});
    const access = await reader.channelAccess(target);
    console.log(`${access.canPost ? "READ_WRITE" : "READ_ONLY"} ${access.title}${access.username ? ` · @${access.username}` : ""} ROLE ${access.role}`);
  } finally {
    await reader.close();
  }
  process.exit(0);
}

if (command === "post") {
  const flags = parseFlags(process.argv.slice(3), new Set(["preview", "silent"]));
  const target = requiredFlag(flags, "channel");
  const textFile = flags.values.get("text-file");
  const markdown = textFile ? await readFile(path.resolve(textFile), "utf8") : flags.values.get("text") ?? "";
  const mediaKindSource = flags.values.get("media-kind");
  if (mediaKindSource && !["photo", "video", "document"].includes(mediaKindSource)) {
    throw new Error("--media-kind must be photo, video, or document");
  }
  const scheduledAt = parseScheduleFlag(flags.values.get("at"));
  const reader = new TelegramChannelReader(await requiredCredentials(), readerDirectory);
  try {
    await reader.login({});
    const result = await reader.publishPost({
      target,
      markdown,
      mediaPath: flags.values.get("media"),
      mediaKind: mediaKindSource as "photo" | "video" | "document" | undefined,
      scheduledAt,
      silent: flags.booleans.has("silent"),
      previewOnly: flags.booleans.has("preview"),
    });
    const status = result.preview ? "PREVIEW_OK" : result.scheduledAt ? "SCHEDULED_CONFIRMED" : "PUBLISHED_CONFIRMED";
    console.log(JSON.stringify({ status, ...result }, null, 2));
  } finally {
    await reader.close();
  }
  process.exit(0);
}

if (command === "scheduled") {
  const target = process.argv.slice(3).join(" ").trim();
  if (!target) throw new Error("Provide a channel username or chat identifier");
  const reader = new TelegramChannelReader(await requiredCredentials(), readerDirectory);
  try {
    await reader.login({});
    const posts = await reader.listScheduledPosts(target);
    console.log(JSON.stringify({ status: "SCHEDULED_POSTS", count: posts.length, posts }, null, 2));
  } finally {
    await reader.close();
  }
  process.exit(0);
}

if (command === "edit-post") {
  const flags = parseFlags(process.argv.slice(3), new Set(["preview"]));
  const target = requiredFlag(flags, "channel");
  const messageId = Number(requiredFlag(flags, "message-id"));
  const textFile = flags.values.get("text-file");
  const markdown = textFile ? await readFile(path.resolve(textFile), "utf8") : flags.values.get("text") ?? "";
  if (!markdown.trim()) throw new Error("Telegram post edit requires --text-file or --text");
  const reader = new TelegramChannelReader(await requiredCredentials(), readerDirectory);
  try {
    await reader.login({});
    const result = await reader.editPostText({
      target,
      messageId,
      markdown,
      previewOnly: flags.booleans.has("preview"),
    });
    console.log(JSON.stringify({ status: result.preview ? "EDIT_PREVIEW_OK" : "EDITED_CONFIRMED", ...result }, null, 2));
  } finally {
    await reader.close();
  }
  process.exit(0);
}

if (command === "export-post") {
  const flags = parseFlags(process.argv.slice(3), new Set());
  const target = requiredFlag(flags, "channel");
  const messageId = Number(requiredFlag(flags, "message-id"));
  const reader = new TelegramChannelReader(await requiredCredentials(), readerDirectory);
  try {
    await reader.login({});
    console.log(JSON.stringify({ status: "POST_SNAPSHOT", ...(await reader.postSnapshot(target, messageId)) }, null, 2));
  } finally {
    await reader.close();
  }
  process.exit(0);
}

if (command === "sync-publications") {
  const snapshot = await syncTelegramArticlePublications(configuration);
  if (!snapshot) throw new Error("Telegram publication sync is not configured");
  console.log(`PUBLICATIONS_SYNCED ${snapshot.publications.length} CHANNELS ${snapshot.channels.length}`);
  process.exit(0);
}

if (command === "join") {
  const credentials = await requiredCredentials();
  const state = await readTelegramReaderState(readerDirectory);
  if (!state) throw new Error("Run npm run telegram:connect-qr first");
  const usernames = process.argv.slice(3).join(" ").split(/[\s,;]+/u).filter(Boolean);
  if (!usernames.length) throw new Error("Provide one or more public Telegram usernames");
  const reader = new TelegramChannelReader(credentials, readerDirectory);
  try {
    await reader.login({});
    const joined = await reader.joinPublicChannels(usernames);
    const availableChannels = await reader.listChannels();
    const availableIds = new Set(availableChannels.map((channel) => channel.chatId));
    const allowedChannels = state.allowedChannels.filter((channel) => availableIds.has(channel.chatId));
    await writeTelegramReaderState(readerDirectory, { ...state, connectedAt: Date.now(), availableChannels, allowedChannels });
    for (const channel of joined) {
      console.log(`${channel.joinedNow ? "JOINED" : "ALREADY_JOINED"} ${channel.title} · @${channel.username}`);
    }
  } finally {
    await reader.close();
  }
  process.exit(0);
}

if (command === "folder") {
  const credentials = await requiredCredentials();
  const state = await readTelegramReaderState(readerDirectory);
  if (!state?.availableChannels.length) throw new Error("Run npm run telegram:connect-qr first");
  const folderName = process.argv[3]?.trim() || "";
  const selected = selectTelegramChannels(state.availableChannels, process.argv.slice(4).join(" ").trim());
  const reader = new TelegramChannelReader(credentials, readerDirectory);
  try {
    await reader.login({});
    const folderId = await reader.createFolder(folderName, selected);
    console.log(`FOLDER_CREATED ${folderName} ID ${folderId} CHANNELS ${selected.length}`);
  } finally {
    await reader.close();
  }
  process.exit(0);
}

if (command === "folder-status") {
  const credentials = await requiredCredentials();
  const folderId = Number(process.argv[3]);
  const reader = new TelegramChannelReader(credentials, readerDirectory);
  try {
    await reader.login({});
    const folder = await reader.getFolder(folderId);
    console.log(`FOLDER ${folder.name} ID ${folder.id} CHANNELS ${folder.includedChatIds.length}`);
  } finally {
    await reader.close();
  }
  process.exit(0);
}

if (command === "folder-add") {
  const credentials = await requiredCredentials();
  const state = await readTelegramReaderState(readerDirectory);
  if (!state?.availableChannels.length) throw new Error("Run npm run telegram:connect-qr first");
  const folderId = Number(process.argv[3]);
  const selected = selectTelegramChannels(state.availableChannels, process.argv.slice(4).join(" ").trim());
  const reader = new TelegramChannelReader(credentials, readerDirectory);
  try {
    await reader.login({});
    const folder = await reader.addChannelsToFolder(folderId, selected);
    console.log(`FOLDER_UPDATED ${folder.name} ID ${folder.id} CHANNELS ${folder.includedChatIds.length}`);
  } finally {
    await reader.close();
  }
  process.exit(0);
}

if (command === "folder-rename") {
  const credentials = await requiredCredentials();
  const folderId = Number(process.argv[3]);
  const folderName = process.argv.slice(4).join(" ").trim();
  const reader = new TelegramChannelReader(credentials, readerDirectory);
  try {
    await reader.login({});
    const folder = await reader.renameFolder(folderId, folderName);
    console.log(`FOLDER_RENAMED ${folder.name} ID ${folder.id} CHANNELS ${folder.includedChatIds.length}`);
  } finally {
    await reader.close();
  }
  process.exit(0);
}

throw new Error(`Unknown Telegram reader command: ${command}`);

async function ensureCredentials(): Promise<TelegramReaderCredentials> {
  const existing = await loadTelegramReaderCredentials();
  if (existing) return existing;
  console.log("Создай приложение в https://my.telegram.org → API development tools.");
  const apiId = await promptVisible("API ID: ");
  const apiHash = await promptHidden("API hash: ");
  return saveTelegramReaderCredentials(apiId, apiHash);
}

async function requiredCredentials(): Promise<TelegramReaderCredentials> {
  const credentials = await loadTelegramReaderCredentials();
  if (!credentials) throw new Error("Run npm run telegram:connect first");
  return credentials;
}

async function promptVisible(label: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return (await readline.question(label)).trim();
  } finally {
    readline.close();
  }
}

async function promptHidden(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) return promptVisible(label);
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function promptMacSecret(message: string): Promise<string> {
  if (process.platform !== "darwin") return promptHidden(`${message}\nПароль: `);
  const script = [
    "set answer to display dialog " + appleScriptString(message) + " default answer \"\" with hidden answer",
    "return text returned of answer",
  ].join("\n");
  try {
    const result = await promisify(execFile)("osascript", ["-e", script], { encoding: "utf8", maxBuffer: 16 * 1024 });
    return result.stdout.replace(/\r?\n$/u, "");
  } catch {
    throw new Error("Telegram 2FA password entry was cancelled");
  }
}

function appleScriptString(value: string): string {
  return `\"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n")}\"`;
}

function shorten(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit).trim()}…`;
}

interface ParsedFlags {
  values: Map<string, string>;
  booleans: Set<string>;
}

function parseFlags(args: readonly string[], booleanNames: ReadonlySet<string>): ParsedFlags {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const source = args[index]!;
    if (!source.startsWith("--")) throw new Error(`Unexpected Telegram post argument: ${source}`);
    const name = source.slice(2);
    if (!name) throw new Error("Invalid empty Telegram post flag");
    if (booleanNames.has(name)) {
      booleans.add(name);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    values.set(name, value);
    index += 1;
  }
  return { values, booleans };
}

function requiredFlag(flags: ParsedFlags, name: string): string {
  const value = flags.values.get(name)?.trim();
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function parseScheduleFlag(source: string | undefined): number | undefined {
  if (!source) return undefined;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(source)) {
    throw new Error("--at must be ISO 8601 with an explicit timezone, for example 2026-08-11T21:39:00+03:00");
  }
  const parsed = Date.parse(source);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid Telegram schedule time: ${source}`);
  return parsed;
}
