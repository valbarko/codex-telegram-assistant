import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { getTdjson } from "prebuilt-tdlib";
import { configure, createClient, type Client, type LoginDetails } from "tdl";

import type { TelegramReaderCredentials } from "./telegram-reader-keychain.js";

const STATE_FILE = "sources.json";
const MAX_CHAT_LOAD_ROUNDS = 25;
const MAX_SCHEDULE_AHEAD_MS = 367 * 24 * 60 * 60_000;
const SEND_CONFIRMATION_TIMEOUT_MS = 90_000;

let tdlibConfigured = false;

export interface TelegramChannel {
  chatId: number;
  title: string;
  username?: string;
}

export interface TelegramChannelMessage {
  chatId: number;
  messageId: number;
  publishedAt: number;
  text: string;
  links?: readonly string[];
  views?: number;
  forwards?: number;
}

export type TelegramPostMediaKind = "photo" | "video" | "document";

export interface TelegramChannelAccess extends TelegramChannel {
  canPost: boolean;
  role: "creator" | "administrator" | "member" | "other";
}

export interface TelegramPostRequest {
  target: string | number;
  markdown: string;
  mediaPath?: string;
  mediaKind?: TelegramPostMediaKind;
  scheduledAt?: number;
  silent?: boolean;
  previewOnly?: boolean;
}

export interface TelegramPostReceipt {
  channel: TelegramChannel;
  preview: boolean;
  messageId?: number;
  scheduledAt?: number;
  contentType: string;
  textLength: number;
  entityCount: number;
  mediaPath?: string;
}

export interface TelegramPostEditRequest {
  target: string | number;
  messageId: number;
  markdown: string;
  previewOnly?: boolean;
}

export interface TelegramPostEditReceipt {
  channel: TelegramChannel;
  preview: boolean;
  messageId: number;
  scheduledAt?: number;
  contentType: string;
  textLength: number;
  entityCount: number;
}

export interface TelegramScheduledPost {
  channel: TelegramChannel;
  messageId: number;
  scheduledAt: number;
  contentType: string;
  text: string;
}

export interface TelegramPostSnapshot extends TelegramScheduledPost {
  markdown: string;
  entityCount: number;
}

export interface TelegramReaderState {
  accountUserId: number;
  accountLabel: string;
  connectedAt: number;
  availableChannels: readonly TelegramChannel[];
  allowedChannels: readonly TelegramChannel[];
}

export interface TelegramJoinedChannel extends TelegramChannel {
  joinedNow: boolean;
}

export interface TelegramFolderSnapshot {
  id: number;
  name: string;
  includedChatIds: readonly number[];
}

export interface TelegramQrLoginOptions {
  onLink: (link: string) => Promise<void>;
  getPassword: (hint: string, retry: boolean) => Promise<string>;
  timeoutMs?: number;
}

interface TdChat {
  id?: unknown;
  title?: unknown;
  type?: { _?: unknown; is_channel?: unknown; supergroup_id?: unknown };
  usernames?: { active_usernames?: unknown };
}

interface TdMessage {
  id?: unknown;
  chat_id?: unknown;
  date?: unknown;
  content?: Record<string, unknown>;
  interaction_info?: { view_count?: unknown; forward_count?: unknown };
}

interface TdFormattedText {
  _: "formattedText";
  text: string;
  entities: unknown[];
}

interface TdOutgoingMessage {
  id?: unknown;
  chat_id?: unknown;
  sending_state?: unknown;
  scheduling_state?: { _?: unknown; send_date?: unknown };
  content?: Record<string, unknown>;
}

type TelegramChatList = { _: "chatListMain" } | { _: "chatListArchive" };

export class TelegramChannelReader {
  private readonly client: Client;
  private chatsLoaded = false;

  constructor(credentials: TelegramReaderCredentials, private readonly directory: string) {
    if (!tdlibConfigured) {
      configure({ tdjson: getTdjson(), verbosityLevel: 0 });
      tdlibConfigured = true;
    }
    const databaseDirectory = path.join(directory, "tdlib");
    const filesDirectory = path.join(directory, "files");
    this.client = createClient({
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      databaseDirectory,
      filesDirectory,
      databaseEncryptionKey: credentials.databaseEncryptionKey,
      skipOldUpdates: true,
      tdlibParameters: {
        use_test_dc: false,
        database_directory: databaseDirectory,
        files_directory: filesDirectory,
        database_encryption_key: credentials.databaseEncryptionKey,
        use_file_database: false,
        use_chat_info_database: false,
        use_message_database: false,
        use_secret_chats: false,
        api_id: credentials.apiId,
        api_hash: credentials.apiHash,
        system_language_code: "ru-RU",
        device_model: "Valentin Mac editorial client",
        system_version: process.platform,
        application_version: "0.1.0",
      },
    });
    this.client.on("error", (error) => console.error("Telegram client error", safeTdlibError(error)));
  }

  async login(details: LoginDetails): Promise<{ id: number; label: string }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.client.login(details);
    return this.accountIdentity();
  }

  async loginWithQr(options: TelegramQrLoginOptions): Promise<{ id: number; label: string }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    return new Promise((resolve, reject) => {
      let settled = false;
      let qrRequested = false;
      let queue = Promise.resolve();
      const timer = setTimeout(() => fail(new Error("Telegram QR login timed out")), timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.client.off("update", onUpdate);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error("Telegram QR login failed"));
      };
      const succeed = async (): Promise<void> => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          resolve(await this.accountIdentity());
        } catch (error) {
          reject(error);
        }
      };
      const handleState = async (state: Record<string, unknown>): Promise<void> => {
        if (settled) return;
        const kind = string(state._);
        if (kind === "authorizationStateReady") return succeed();
        if (kind === "authorizationStateClosed" || kind === "authorizationStateClosing") {
          throw new Error("Telegram closed the authorization session");
        }
        if (kind === "authorizationStateWaitPhoneNumber") {
          if (qrRequested) return;
          qrRequested = true;
          await this.client.invoke({ _: "requestQrCodeAuthentication", other_user_ids: [] });
          return;
        }
        if (kind === "authorizationStateWaitOtherDeviceConfirmation") {
          const link = string(state.link);
          if (!link.startsWith("tg://login?token=")) throw new Error("Telegram returned an invalid QR login link");
          await options.onLink(link);
          return;
        }
        if (kind === "authorizationStateWaitPassword") {
          let retry = false;
          while (!settled) {
            const password = await options.getPassword(string(state.password_hint), retry);
            try {
              await this.client.invoke({ _: "checkAuthenticationPassword", password });
              return;
            } catch (error) {
              if (tdlibErrorCode(error) !== 400) throw error;
              retry = true;
            }
          }
        }
      };
      const onUpdate = (update: { _?: unknown; authorization_state?: unknown }): void => {
        if (update._ !== "updateAuthorizationState" || !update.authorization_state
          || typeof update.authorization_state !== "object") return;
        queue = queue.then(() => handleState(update.authorization_state as Record<string, unknown>)).catch(fail);
      };
      this.client.on("update", onUpdate);
      void this.client.invoke({ _: "getAuthorizationState" })
        .then((state) => handleState(state as Record<string, unknown>)).catch(fail);
    });
  }

  private async accountIdentity(): Promise<{ id: number; label: string }> {
    const account = await this.client.invoke({ _: "getMe" });
    const id = numeric(account.id);
    const names = [string(account.first_name), string(account.last_name)].filter(Boolean).join(" ");
    const username = string(account.usernames?.active_usernames?.[0]);
    return { id, label: names || (username ? `@${username}` : `Telegram ${id}`) };
  }

  async listChannels(): Promise<TelegramChannel[]> {
    await this.ensureChatsLoaded();
    const ids = new Set<number>();
    const chatLists: TelegramChatList[] = [{ _: "chatListMain" }, { _: "chatListArchive" }];
    for (const chatList of chatLists) {
      const result = await this.client.invoke({ _: "getChats", chat_list: chatList, limit: 10_000 });
      for (const id of array(result.chat_ids)) if (typeof id === "number") ids.add(id);
    }
    const chats: TdChat[] = [];
    for (const chatId of ids) chats.push(await this.client.invoke({ _: "getChat", chat_id: chatId }) as TdChat);
    return filterTelegramChannels(chats);
  }

  async readRecent(channel: TelegramChannel, limit = 10): Promise<TelegramChannelMessage[]> {
    await this.ensureChatsLoaded();
    return this.chatHistory(channel.chatId, limit);
  }

  async readRecentFresh(channel: TelegramChannel, limit = 100): Promise<TelegramChannelMessage[]> {
    const username = channel.username?.trim().replace(/^@/u, "");
    const publicChat = username && /^[A-Za-z\d_]{5,32}$/u.test(username)
      ? await this.client.invoke({ _: "searchPublicChat", username }) as TdChat
      : undefined;
    const chatId = numeric(publicChat?.id) || channel.chatId;
    await this.client.invoke({ _: "openChat", chat_id: chatId });
    try {
      let messages: TelegramChannelMessage[] = [];
      for (const delay of [1_200, 700, 700]) {
        await wait(delay);
        const refreshed = await this.chatHistory(chatId, limit);
        if (refreshed.length > messages.length) messages = refreshed;
        if (messages.length >= Math.min(limit, 20)) break;
      }
      return messages;
    } finally {
      await this.client.invoke({ _: "closeChat", chat_id: chatId }).catch(() => undefined);
    }
  }

  async channelAccess(target: string | number): Promise<TelegramChannelAccess> {
    const chat = await this.resolveChannel(target);
    const channel = filterTelegramChannels([chat])[0];
    if (!channel) throw new Error(`Telegram target ${String(target)} is not a broadcast channel`);
    const supergroupId = numeric(chat.type?.supergroup_id);
    if (!supergroupId) throw new Error(`Telegram didn't return channel permissions for ${channel.title}`);
    const supergroup = await this.client.invoke({ _: "getSupergroup", supergroup_id: supergroupId });
    const status = supergroup.status as Record<string, unknown> | undefined;
    const statusKind = string(status?._);
    const rights = status?.rights as Record<string, unknown> | undefined;
    const role = telegramChannelRole(statusKind);
    const canPost = statusKind === "chatMemberStatusCreator"
      || (statusKind === "chatMemberStatusAdministrator" && rights?.can_post_messages === true);
    return { ...channel, canPost, role };
  }

  async publishPost(request: TelegramPostRequest): Promise<TelegramPostReceipt> {
    const access = await this.channelAccess(request.target);
    if (!access.canPost) throw new Error(`The connected Telegram account can't publish to ${access.title}`);
    const markdown = request.markdown.trim();
    const mediaPath = request.mediaPath ? path.resolve(request.mediaPath) : undefined;
    if (!markdown && !mediaPath) throw new Error("Telegram post requires text or a media file");
    if (mediaPath && !(await stat(mediaPath)).isFile()) throw new Error(`Telegram media is not a file: ${mediaPath}`);
    const scheduledAt = validateTelegramScheduleTime(request.scheduledAt);
    const formatted = await this.invokeRaw<TdFormattedText>({
      _: "parseMarkdown",
      text: { _: "formattedText", text: markdown, entities: [] },
    });
    const inputMessageContent = telegramPostContent(formatted, mediaPath,
      request.mediaKind ?? (mediaPath ? detectTelegramPostMediaKind(mediaPath) : undefined));
    const schedulingState = scheduledAt === undefined ? undefined : {
      _: "messageSchedulingStateSendAtDate",
      send_date: Math.floor(scheduledAt / 1_000),
      repeat_period: 0,
    };
    const baseOptions = {
      _: "messageSendOptions",
      disable_notification: request.silent === true,
      from_background: false,
      protect_content: false,
      allow_paid_broadcast: false,
      update_order_of_installed_sticker_sets: false,
      ...(schedulingState ? { scheduling_state: schedulingState } : {}),
    };
    const preview = await this.invokeRaw<TdOutgoingMessage>({
      _: "sendMessage",
      chat_id: access.chatId,
      options: { ...baseOptions, only_preview: true },
      input_message_content: inputMessageContent,
    });
    if (request.previewOnly) {
      return telegramPostReceipt(access, preview, formatted, mediaPath, scheduledAt, true);
    }
    const sendCommand = {
      _: "sendMessage",
      chat_id: access.chatId,
      options: { ...baseOptions, sending_id: Date.now() % 2_147_483_647, only_preview: false },
      input_message_content: inputMessageContent,
    };
    const confirmed = schedulingState
      ? await this.confirmScheduledPost(access.chatId, await this.invokeRaw<TdOutgoingMessage>(sendCommand),
        formatted.text, schedulingState.send_date)
      : await this.sendAndConfirmImmediate(sendCommand);
    return telegramPostReceipt(access, confirmed, formatted, mediaPath, scheduledAt, false);
  }

  async listScheduledPosts(target: string | number): Promise<TelegramScheduledPost[]> {
    const access = await this.channelAccess(target);
    const result = await this.invokeRaw<{ messages?: TdOutgoingMessage[] }>({
      _: "getChatScheduledMessages",
      chat_id: access.chatId,
    });
    return (result.messages ?? []).flatMap((message) => {
      const messageId = numeric(message.id);
      const sendDate = message.scheduling_state?._ === "messageSchedulingStateSendAtDate"
        ? numeric(message.scheduling_state.send_date) : 0;
      if (!messageId || !sendDate) return [];
      return [{
        channel: access,
        messageId,
        scheduledAt: sendDate * 1_000,
        contentType: string(message.content?._),
        text: outgoingMessageText(message.content),
      }];
    });
  }

  async editPostText(request: TelegramPostEditRequest): Promise<TelegramPostEditReceipt> {
    const access = await this.channelAccess(request.target);
    if (!access.canPost) throw new Error(`The connected Telegram account can't edit posts in ${access.title}`);
    if (!Number.isSafeInteger(request.messageId) || request.messageId <= 0) throw new Error("Invalid Telegram message identifier");
    const current = await this.findMessage(access.chatId, request.messageId);
    if (!current) throw new Error(`Telegram message ${request.messageId} wasn't found in ${access.title}`);
    const properties = await this.invokeRaw<{ can_be_edited?: boolean }>({
      _: "getMessageProperties",
      chat_id: access.chatId,
      message_id: request.messageId,
    });
    if (properties.can_be_edited !== true) throw new Error(`Telegram message ${request.messageId} can't be edited`);
    const formatted = await this.invokeRaw<TdFormattedText>({
      _: "parseMarkdown",
      text: { _: "formattedText", text: request.markdown.trim(), entities: [] },
    });
    const contentType = string(current.content?._);
    const isText = contentType === "messageText";
    const isCaption = ["messagePhoto", "messageVideo", "messageAnimation", "messageDocument", "messageAudio"].includes(contentType);
    if (!isText && !isCaption) throw new Error(`Telegram content ${contentType || "unknown"} doesn't support text editing`);
    const limitOption = await this.invokeRaw<{ value?: unknown }>({
      _: "getOption",
      name: isText ? "message_text_length_max" : "message_caption_length_max",
    });
    const limit = integerOption(limitOption.value);
    if (limit && formatted.text.length > limit) {
      throw new Error(`Telegram text has ${formatted.text.length} characters, limit is ${limit}`);
    }
    if (request.previewOnly) return telegramPostEditReceipt(access, current, formatted, true);
    const edited = isText
      ? await this.invokeRaw<TdOutgoingMessage>({
        _: "editMessageText",
        chat_id: access.chatId,
        message_id: request.messageId,
        input_message_content: { _: "inputMessageText", text: formatted, clear_draft: false },
      })
      : await this.invokeRaw<TdOutgoingMessage>({
        _: "editMessageCaption",
        chat_id: access.chatId,
        message_id: request.messageId,
        caption: formatted,
        show_caption_above_media: false,
      });
    if (numeric(edited.id) !== request.messageId || outgoingMessageText(edited.content) !== formatted.text) {
      throw new Error("Telegram returned an edited post that doesn't match the approved text");
    }
    return telegramPostEditReceipt(access, edited, formatted, false);
  }

  async postSnapshot(target: string | number, messageId: number): Promise<TelegramPostSnapshot> {
    const access = await this.channelAccess(target);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("Invalid Telegram message identifier");
    const message = await this.findMessage(access.chatId, messageId);
    if (!message) throw new Error(`Telegram message ${messageId} wasn't found in ${access.title}`);
    const formatted = outgoingMessageFormattedText(message.content);
    if (!formatted) throw new Error(`Telegram message ${messageId} has no exportable text`);
    const markdown = await this.invokeRaw<TdFormattedText>({ _: "getMarkdownText", text: formatted });
    const sendDate = message.scheduling_state?._ === "messageSchedulingStateSendAtDate"
      ? numeric(message.scheduling_state.send_date) : 0;
    return {
      channel: access,
      messageId,
      scheduledAt: sendDate * 1_000,
      contentType: string(message.content?._),
      text: formatted.text,
      markdown: markdown.text,
      entityCount: formatted.entities.length,
    };
  }

  async messageLink(message: Pick<TelegramChannelMessage, "chatId" | "messageId">): Promise<string | undefined> {
    try {
      const result = await this.client.invoke({
        _: "getMessageLink",
        chat_id: message.chatId,
        message_id: message.messageId,
        media_timestamp: 0,
        for_album: false,
        in_message_thread: false,
      });
      const link = string(result.link).trim();
      return /^https:\/\/t\.me\//iu.test(link) ? link : undefined;
    } catch {
      return undefined;
    }
  }

  async joinPublicChannels(usernames: readonly string[]): Promise<TelegramJoinedChannel[]> {
    const channels: TelegramJoinedChannel[] = [];
    for (const source of usernames) {
      const username = source.trim().replace(/^@/u, "");
      if (!/^[A-Za-z\d_]{5,32}$/u.test(username)) throw new Error(`Invalid public Telegram username: ${source}`);
      const chat = await this.client.invoke({ _: "searchPublicChat", username }) as TdChat;
      const channel = filterTelegramChannels([chat])[0];
      if (!channel) throw new Error(`@${username} is not a broadcast channel`);
      const supergroupId = numeric((chat.type as Record<string, unknown> | undefined)?.supergroup_id);
      if (!supergroupId) throw new Error(`Telegram didn't return supergroup data for @${username}`);
      const supergroup = await this.client.invoke({ _: "getSupergroup", supergroup_id: supergroupId });
      const status = string(supergroup.status?._);
      if (status === "chatMemberStatusBanned") throw new Error(`The account is banned from @${username}`);
      const joinedNow = status === "chatMemberStatusLeft";
      if (joinedNow) await this.client.invoke({ _: "joinChat", chat_id: channel.chatId });
      channels.push({ ...channel, username, joinedNow });
    }
    return channels;
  }

  async createFolder(name: string, channels: readonly TelegramChannel[]): Promise<number> {
    const folderName = name.trim();
    if (!folderName || folderName.length > 32) throw new Error("Telegram folder name must contain 1-32 characters");
    const includedChatIds = [...new Set(channels.map((channel) => channel.chatId))];
    if (!includedChatIds.length) throw new Error("Choose at least one channel for the Telegram folder");
    await this.ensureChatsLoaded();
    const result = await this.client.invoke({
      _: "createChatFolder",
      folder: {
        _: "chatFolder",
        name: {
          _: "chatFolderName",
          text: { _: "formattedText", text: folderName, entities: [] },
          animate_custom_emoji: false,
        },
        icon: { _: "chatFolderIcon", name: "Light" },
        color_id: -1,
        is_shareable: false,
        pinned_chat_ids: [],
        included_chat_ids: includedChatIds,
        excluded_chat_ids: [],
        exclude_muted: false,
        exclude_read: false,
        exclude_archived: false,
        include_contacts: false,
        include_non_contacts: false,
        include_bots: false,
        include_groups: false,
        include_channels: false,
      },
    });
    const folderId = numeric(result.id);
    if (!folderId) throw new Error("Telegram created a folder without an identifier");
    return folderId;
  }

  async getFolder(folderId: number): Promise<TelegramFolderSnapshot> {
    if (!Number.isSafeInteger(folderId) || folderId <= 0) throw new Error("Invalid Telegram folder identifier");
    const result = await this.client.invoke({ _: "getChatFolder", chat_folder_id: folderId });
    return {
      id: folderId,
      name: formattedText(result.name?.text),
      includedChatIds: array(result.included_chat_ids).filter((value): value is number => typeof value === "number"),
    };
  }

  async addChannelsToFolder(folderId: number, channels: readonly TelegramChannel[]): Promise<TelegramFolderSnapshot> {
    if (!Number.isSafeInteger(folderId) || folderId <= 0) throw new Error("Invalid Telegram folder identifier");
    if (!channels.length) throw new Error("Choose at least one channel to add to the Telegram folder");
    await this.ensureChatsLoaded();
    const folder = await this.client.invoke({ _: "getChatFolder", chat_folder_id: folderId });
    const includedChatIds = [...new Set([
      ...array(folder.included_chat_ids).filter((value): value is number => typeof value === "number"),
      ...channels.map((channel) => channel.chatId),
    ])];
    await this.client.invoke({
      _: "editChatFolder",
      chat_folder_id: folderId,
      folder: { ...folder, included_chat_ids: includedChatIds },
    });
    return this.getFolder(folderId);
  }

  async renameFolder(folderId: number, name: string): Promise<TelegramFolderSnapshot> {
    if (!Number.isSafeInteger(folderId) || folderId <= 0) throw new Error("Invalid Telegram folder identifier");
    const folderName = name.trim();
    if (!folderName || folderName.length > 12) throw new Error("Telegram folder name must contain 1-12 characters");
    const folder = await this.client.invoke({ _: "getChatFolder", chat_folder_id: folderId });
    await this.client.invoke({
      _: "editChatFolder",
      chat_folder_id: folderId,
      folder: {
        ...folder,
        name: {
          _: "chatFolderName",
          text: { _: "formattedText", text: folderName, entities: [] },
          animate_custom_emoji: false,
        },
      },
    });
    return this.getFolder(folderId);
  }

  async close(): Promise<void> {
    if (!this.client.isClosed()) await this.client.close();
  }

  private async resolveChannel(target: string | number): Promise<TdChat> {
    if (typeof target === "number" || /^-?\d+$/u.test(target.trim())) {
      const chatId = typeof target === "number" ? target : Number(target.trim());
      if (!Number.isSafeInteger(chatId) || !chatId) throw new Error(`Invalid Telegram chat identifier: ${String(target)}`);
      return this.client.invoke({ _: "getChat", chat_id: chatId }) as Promise<TdChat>;
    }
    const username = target.trim().replace(/^@/u, "");
    if (!/^[A-Za-z\d_]{5,32}$/u.test(username)) throw new Error(`Invalid public Telegram username: ${String(target)}`);
    return this.client.invoke({ _: "searchPublicChat", username }) as Promise<TdChat>;
  }

  private async confirmScheduledPost(
    chatId: number,
    pending: TdOutgoingMessage,
    text: string,
    sendDate: number,
  ): Promise<TdOutgoingMessage> {
    const deadline = Date.now() + SEND_CONFIRMATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await this.invokeRaw<{ messages?: TdOutgoingMessage[] }>({
        _: "getChatScheduledMessages",
        chat_id: chatId,
      });
      const confirmed = (result.messages ?? []).find((message) => numeric(message.id) === numeric(pending.id)
        || (message.scheduling_state?._ === "messageSchedulingStateSendAtDate"
          && numeric(message.scheduling_state.send_date) === sendDate
          && outgoingMessageText(message.content) === text));
      if (confirmed && !confirmed.sending_state) return confirmed;
      await wait(750);
    }
    throw new Error("Telegram didn't confirm the scheduled post after media upload");
  }

  private async findMessage(chatId: number, messageId: number): Promise<TdOutgoingMessage | undefined> {
    const messages = await this.invokeRaw<{ messages?: Array<TdOutgoingMessage | null> }>({
      _: "getMessages",
      chat_id: chatId,
      message_ids: [messageId],
    });
    const direct = messages.messages?.find((message): message is TdOutgoingMessage => Boolean(message));
    if (direct) return direct;
    const scheduled = await this.invokeRaw<{ messages?: TdOutgoingMessage[] }>({
      _: "getChatScheduledMessages",
      chat_id: chatId,
    });
    return scheduled.messages?.find((message) => numeric(message.id) === messageId);
  }

  private async sendAndConfirmImmediate(command: Record<string, unknown>): Promise<TdOutgoingMessage> {
    const updates: Record<string, unknown>[] = [];
    const onUpdate = (update: Record<string, unknown>): void => {
      if (update._ === "updateMessageSendSucceeded" || update._ === "updateMessageSendFailed") updates.push(update);
    };
    this.client.on("update", onUpdate);
    try {
      const pending = await this.invokeRaw<TdOutgoingMessage>(command);
      if (!pending.sending_state) return pending;
      const pendingId = numeric(pending.id);
      const deadline = Date.now() + SEND_CONFIRMATION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const update = updates.find((candidate) => numeric(candidate.old_message_id) === pendingId);
        if (update?._ === "updateMessageSendSucceeded") return update.message as TdOutgoingMessage;
        if (update?._ === "updateMessageSendFailed") {
          const failure = update.error as Record<string, unknown> | undefined;
          throw new Error(`Telegram post failed: ${string(failure?.message) || "unknown error"}`);
        }
        await wait(100);
      }
      throw new Error("Telegram didn't confirm the published post");
    } finally {
      this.client.off("update", onUpdate);
    }
  }

  private invokeRaw<T>(command: Record<string, unknown>): Promise<T> {
    return this.client.invoke(command as never) as unknown as Promise<T>;
  }

  private async loadChats(chatList: TelegramChatList): Promise<void> {
    for (let round = 0; round < MAX_CHAT_LOAD_ROUNDS; round += 1) {
      try {
        await this.client.invoke({ _: "loadChats", chat_list: chatList, limit: 100 });
      } catch (error) {
        if (tdlibErrorCode(error) === 404) return;
        throw error;
      }
    }
  }

  private async ensureChatsLoaded(): Promise<void> {
    if (this.chatsLoaded) return;
    await this.loadChats({ _: "chatListMain" });
    await this.loadChats({ _: "chatListArchive" });
    this.chatsLoaded = true;
  }

  private async chatHistory(chatId: number, limit: number): Promise<TelegramChannelMessage[]> {
    const result = await this.client.invoke({
      _: "getChatHistory", chat_id: chatId, from_message_id: 0, offset: 0, limit: Math.min(100, limit),
      only_local: false,
    });
    return array(result.messages).flatMap((message) => {
      const normalized = extractTelegramChannelMessage(message as TdMessage);
      return normalized ? [normalized] : [];
    });
  }
}

export function detectTelegramPostMediaKind(mediaPath: string): TelegramPostMediaKind {
  const extension = path.extname(mediaPath).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(extension)) return "photo";
  if ([".mp4", ".m4v", ".mov"].includes(extension)) return "video";
  return "document";
}

export function validateTelegramScheduleTime(scheduledAt: number | undefined, now = Date.now()): number | undefined {
  if (scheduledAt === undefined) return undefined;
  if (!Number.isSafeInteger(scheduledAt)) throw new Error("Telegram schedule time must be a Unix timestamp in milliseconds");
  if (scheduledAt <= now) throw new Error("Telegram schedule time must be in the future");
  if (scheduledAt > now + MAX_SCHEDULE_AHEAD_MS) throw new Error("Telegram posts can be scheduled at most 367 days ahead");
  return scheduledAt;
}

function telegramPostContent(
  formatted: TdFormattedText,
  mediaPath: string | undefined,
  mediaKind: TelegramPostMediaKind | undefined,
): Record<string, unknown> {
  if (!mediaPath) {
    return { _: "inputMessageText", text: formatted, clear_draft: false };
  }
  const inputFile = { _: "inputFileLocal", path: mediaPath };
  if (mediaKind === "photo") {
    return {
      _: "inputMessagePhoto",
      photo: { _: "inputPhoto", photo: inputFile, added_sticker_file_ids: [], width: 0, height: 0 },
      caption: formatted,
      show_caption_above_media: false,
      has_spoiler: false,
    };
  }
  if (mediaKind === "video") {
    return {
      _: "inputMessageVideo",
      video: {
        _: "inputVideo",
        video: inputFile,
        start_timestamp: 0,
        added_sticker_file_ids: [],
        duration: 0,
        width: 0,
        height: 0,
        supports_streaming: true,
      },
      caption: formatted,
      show_caption_above_media: false,
      has_spoiler: false,
    };
  }
  return {
    _: "inputMessageDocument",
    document: { _: "inputDocument", document: inputFile, disable_content_type_detection: false },
    caption: formatted,
  };
}

function telegramPostReceipt(
  channel: TelegramChannel,
  message: TdOutgoingMessage,
  formatted: TdFormattedText,
  mediaPath: string | undefined,
  scheduledAt: number | undefined,
  preview: boolean,
): TelegramPostReceipt {
  const messageId = numeric(message.id) || undefined;
  return {
    channel,
    preview,
    ...(preview ? {} : { messageId }),
    ...(scheduledAt === undefined ? {} : { scheduledAt }),
    contentType: string(message.content?._),
    textLength: formatted.text.length,
    entityCount: formatted.entities.length,
    ...(mediaPath ? { mediaPath } : {}),
  };
}

function telegramPostEditReceipt(
  channel: TelegramChannel,
  message: TdOutgoingMessage,
  formatted: TdFormattedText,
  preview: boolean,
): TelegramPostEditReceipt {
  const sendDate = message.scheduling_state?._ === "messageSchedulingStateSendAtDate"
    ? numeric(message.scheduling_state.send_date) : 0;
  return {
    channel,
    preview,
    messageId: numeric(message.id),
    ...(sendDate ? { scheduledAt: sendDate * 1_000 } : {}),
    contentType: string(message.content?._),
    textLength: formatted.text.length,
    entityCount: formatted.entities.length,
  };
}

function telegramChannelRole(status: string): TelegramChannelAccess["role"] {
  if (status === "chatMemberStatusCreator") return "creator";
  if (status === "chatMemberStatusAdministrator") return "administrator";
  if (status === "chatMemberStatusMember") return "member";
  return "other";
}

function outgoingMessageText(content: Record<string, unknown> | undefined): string {
  return outgoingMessageFormattedText(content)?.text ?? "";
}

function outgoingMessageFormattedText(content: Record<string, unknown> | undefined): TdFormattedText | undefined {
  if (!content) return undefined;
  const value = content._ === "messageText" ? content.text
    : ["messagePhoto", "messageVideo", "messageAnimation", "messageDocument", "messageAudio"].includes(String(content._))
      ? content.caption : undefined;
  if (!value || typeof value !== "object") return undefined;
  const formatted = value as Record<string, unknown>;
  if (typeof formatted.text !== "string") return undefined;
  return {
    _: "formattedText",
    text: formatted.text,
    entities: Array.isArray(formatted.entities) ? formatted.entities : [],
  };
}

export function filterTelegramChannels(chats: readonly TdChat[]): TelegramChannel[] {
  return chats.flatMap((chat) => {
    if (chat.type?._ !== "chatTypeSupergroup" || chat.type.is_channel !== true) return [];
    const chatId = numeric(chat.id);
    const title = string(chat.title).trim();
    if (!chatId || !title) return [];
    const username = array(chat.usernames?.active_usernames).find((value): value is string => typeof value === "string");
    return [{ chatId, title, username }];
  }).sort((left, right) => left.title.localeCompare(right.title, "ru"));
}

export function extractTelegramChannelMessage(message: TdMessage): TelegramChannelMessage | undefined {
  const content = messageText(message.content);
  if (!content.text) return undefined;
  const chatId = numeric(message.chat_id);
  const messageId = numeric(message.id);
  const date = numeric(message.date);
  if (!chatId || !messageId || !date) return undefined;
  const links = [...new Set(content.links)].filter((link) => /^https?:\/\//iu.test(link));
  const views = numeric(message.interaction_info?.view_count) || undefined;
  const forwards = numeric(message.interaction_info?.forward_count) || undefined;
  return {
    chatId,
    messageId,
    publishedAt: date * 1_000,
    text: content.text,
    ...(links.length ? { links } : {}),
    ...(views ? { views } : {}),
    ...(forwards ? { forwards } : {}),
  };
}

export function selectTelegramChannels(channels: readonly TelegramChannel[], source: string): TelegramChannel[] {
  const indexes = [...new Set(source.split(/[\s,;]+/u).filter(Boolean).map((value) => Number(value)))];
  if (!indexes.length || indexes.some((value) => !Number.isSafeInteger(value) || value < 1 || value > channels.length)) {
    throw new Error("Choose channel numbers from the displayed list");
  }
  return indexes.map((index) => channels[index - 1]!);
}

export async function readTelegramReaderState(directory: string): Promise<TelegramReaderState | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(directory, STATE_FILE), "utf8")) as TelegramReaderState;
    if (!Number.isSafeInteger(value.accountUserId) || !Array.isArray(value.allowedChannels)) return undefined;
    return { ...value, availableChannels: Array.isArray(value.availableChannels) ? value.availableChannels : [] };
  } catch {
    return undefined;
  }
}

export async function writeTelegramReaderState(directory: string, state: TelegramReaderState): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, STATE_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(directory, 0o700);
  await chmod(target, 0o600);
}

function messageText(content: Record<string, unknown> | undefined): { text: string; links: string[] } {
  if (!content) return { text: "", links: [] };
  if (content._ === "messageText") return formattedTextAndLinks(content.text);
  if (["messagePhoto", "messageVideo", "messageAnimation", "messageDocument", "messageAudio"].includes(String(content._))) {
    return formattedTextAndLinks(content.caption);
  }
  return { text: "", links: [] };
}

function formattedText(value: unknown): string {
  return formattedTextAndLinks(value).text;
}

function formattedTextAndLinks(value: unknown): { text: string; links: string[] } {
  if (!value || typeof value !== "object") return { text: "", links: [] };
  const formatted = value as Record<string, unknown>;
  const source = string(formatted.text);
  const text = source.replace(/[\u00a0\s]+/gu, " ").trim();
  const links = array(formatted.entities).flatMap((entity) => {
    if (!entity || typeof entity !== "object") return [];
    const row = entity as Record<string, unknown>;
    const type = row.type && typeof row.type === "object" ? row.type as Record<string, unknown> : undefined;
    if (type?._ === "textEntityTypeTextUrl") return [string(type.url)];
    if (type?._ !== "textEntityTypeUrl") return [];
    const offset = numeric(row.offset);
    const length = numeric(row.length);
    return length ? [source.slice(offset, offset + length)] : [];
  });
  links.push(...(source.match(/https?:\/\/[^\s<>]+/giu) ?? []).map((link) => link.replace(/[),.;!?]+$/u, "")));
  return { text, links };
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function integerOption(value: unknown): number {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : 0;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tdlibErrorCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
    ? error.code : undefined;
}

function safeTdlibError(error: Error): string {
  return `${error.name}: ${error.message}`.replace(/[a-f\d]{32,}/giu, "[secret]");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
