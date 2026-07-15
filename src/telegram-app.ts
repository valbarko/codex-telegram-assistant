import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, InlineKeyboard, InputFile, Keyboard, type Context } from "grammy";

import type { AppConfiguration } from "./configuration.js";
import { formatPlainTranscript, structureTranscript, transcribeAudio } from "./audio.js";
import { CodexHub, type ApprovalChoice, type ApprovalPrompt, type Conversation, type StoredThread, type TurnObserver,
  type UserInputAnswers, type UserInputPrompt, type UserInputQuestion } from "./codex-engine.js";
import { ForwardedVoiceBatcher, ForwardedVoiceEditor, forwardedVoiceHeading,
  type ForwardedVoiceBatch, type ForwardedVoiceFragment } from "./forwarded-voice.js";
import { activateCodexWithResume, addCalendarEvent, addSystemAlarm, appendAppleNote, makeMailDraft, upcomingCalendar } from "./mac-bridge.js";
import { MemoryService, type RecallHit } from "./memory-service.js";
import { normalizeCalendarTitle, parseTemporalCodexResponse, understandAlarm, type ParsedAlarm } from "./reminder-language.js";
import { localCommandFallbackPrompt, quietCodexPrompt } from "./prompt-policy.js";
import { AssistantDatabase, type CapturedItem, type VoiceWritingSettings, type WorkItem } from "./storage.js";
import { isTranscriptionMedia, telegramAccessMode } from "./telegram-access.js";
import { transcriptionCopyPresentation } from "./telegram-copy.js";
import { renderTelegramMarkdown, sendTelegramMarkdown, telegramMarkdownChunks } from "./telegram-markdown.js";
import { isStyleWritingKind, parseSpokenVoiceCommand, VoiceWritingArchive, VoiceWritingEditor,
  type EditedVoiceEntry, type SpokenVoiceCommand } from "./voice-writing.js";

const TELEGRAM_LIMIT = 4000;

type PendingInput = "task" | "capture" | "memory" | "search" | "reminder" | "recall" | "forget" | "story";

interface ApprovalWaiter {
  context: string;
  settle: (choice: ApprovalChoice) => void;
  timer: NodeJS.Timeout;
}

interface PendingCalendarEvent { title: string; start: number; }

interface ForwardedSourceInfo { sender?: string; time?: number; key?: string; }

interface UserQuestionWaiter {
  context: string;
  options: readonly string[];
  acceptsText: boolean;
  waitingText: boolean;
  settle: (answers: string[]) => void;
  timer: NodeJS.Timeout;
}

export class TelegramApplication {
  readonly bot: Bot<Context>;
  private readonly pending = new Map<string, PendingInput>();
  private readonly approvals = new Map<string, ApprovalWaiter>();
  private readonly projectChoices = new Map<string, string[]>();
  private readonly taskProjectChoices = new Map<string, { taskId: string; projects: string[] }>();
  private readonly calendarEvents = new Map<string, PendingCalendarEvent>();
  private readonly userQuestions = new Map<string, UserQuestionWaiter>();
  private readonly userQuestionByContext = new Map<string, string>();
  private readonly voiceEditor: VoiceWritingEditor;
  private readonly voiceArchive: VoiceWritingArchive;
  private readonly forwardedVoiceEditor: ForwardedVoiceEditor;
  private readonly forwardedVoiceBatcher: ForwardedVoiceBatcher;
  private readonly forwardedVoiceFlushes = new Map<string, Promise<void>>();

  constructor(
    private readonly configuration: AppConfiguration,
    private readonly hub: CodexHub,
    private readonly database: AssistantDatabase,
    private readonly memory: MemoryService,
  ) {
    this.voiceEditor = new VoiceWritingEditor(configuration, hub);
    this.voiceArchive = new VoiceWritingArchive(configuration.writingArchiveDirectory);
    this.forwardedVoiceEditor = new ForwardedVoiceEditor(configuration, hub);
    this.forwardedVoiceBatcher = new ForwardedVoiceBatcher((batch) => this.enqueueForwardedVoiceBatch(batch));
    this.bot = new Bot(configuration.telegramToken);
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 8 }));
    this.install();
  }

  async registerCommands(): Promise<void> {
    await this.bot.api.setMyCommands([
      { command: "home", description: "Рабочий центр" },
      { command: "task", description: "Создать задачу" },
      { command: "tasks", description: "Активные задачи" },
      { command: "inbox", description: "Входящие идеи и пересылки" },
      { command: "chat", description: "Новый чат без проекта" },
      { command: "new", description: "Новый проектный тред" },
      { command: "session", description: "Текущий Codex-тред" },
      { command: "sessions", description: "Последние Codex-треды" },
      { command: "rename", description: "Переименовать текущий тред" },
      { command: "fork", description: "Создать копию текущего треда" },
      { command: "archive", description: "Архивировать текущий тред" },
      { command: "abort", description: "Остановить текущий ход" },
      { command: "remind", description: "Создать напоминание" },
      { command: "reminders", description: "Активные напоминания" },
      { command: "remember", description: "Сохранить в память" },
      { command: "memory", description: "Память ассистента" },
      { command: "recall", description: "Найти в долговременной памяти" },
      { command: "forget", description: "Удалить запись из памяти" },
      { command: "about_me", description: "Что ассистент знает обо мне" },
      { command: "memory_status", description: "Состояние долговременной памяти" },
      { command: "memory_pause", description: "Приостановить или включить память" },
      { command: "memory_export", description: "Экспорт долговременной памяти" },
      { command: "voice", description: "Метки для текста и голосовых" },
      { command: "story", description: "Выбрать цикл рассказов" },
      { command: "search", description: "Поиск по рабочей памяти" },
      { command: "launch_profiles", description: "Профиль разрешений" },
      { command: "mail", description: "Последние письма через Gmail" },
      { command: "calendar", description: "Ближайшие события Apple Calendar" },
      { command: "event", description: "Создать событие календаря" },
      { command: "draft", description: "Создать черновик Apple Mail" },
      { command: "schedule", description: "Запланировать задачу Codex" },
      { command: "digest", description: "Утренний и вечерний дайджест" },
      { command: "mac", description: "Продолжить текущий тред на Mac" },
      { command: "health", description: "Проверить бот и app-server" },
      { command: "help", description: "Справка" },
    ]);
  }

  async start(): Promise<void> {
    await this.registerCommands();
    await this.bot.start({ drop_pending_updates: true });
  }

  stop(): void {
    this.forwardedVoiceBatcher.stop();
    this.bot.stop();
  }

  private install(): void {
    this.bot.use(async (ctx, next) => {
      const access = telegramAccessMode(this.configuration, ctx.from?.id);
      if (access === "full" || (access === "transcription-only" && isTranscriptionMedia(ctx))) {
        await next();
      } else if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Нет доступа" }).catch(() => undefined);
      } else if (ctx.chat) {
        const message = access === "transcription-only"
          ? "Доступна только расшифровка голосовых сообщений и аудиофайлов."
          : "Нет доступа";
        await ctx.reply(message).catch(() => undefined);
      }
    });

    this.bot.use(async (ctx, next) => {
      const text = ctx.message?.text?.trim();
      if (text?.startsWith("/")) {
        await this.memory.record({ owner: ownerId(ctx), body: text, role: "action", kind: "action", project: this.memoryProject(ctx), source: "telegram-command" });
      }
      const callback = ctx.callbackQuery?.data;
      if (callback) {
        await this.memory.record({ owner: ownerId(ctx), body: callback, role: "action", kind: "action", project: this.memoryProject(ctx), source: "telegram-button" });
      }
      await next();
    });

    this.bot.command("start", async (ctx) => {
      await ctx.reply("<b>Codex Telegram Assistant работает.</b>\n\nОткройте /home или отправьте сообщение.", {
        parse_mode: "HTML", reply_markup: persistentKeyboard(),
      });
    });

    this.bot.command("help", async (ctx) => {
      await ctx.reply([
        "<b>Основное</b>", "/home · /task · /tasks · /inbox", "",
        "<b>Codex</b>", "/chat · /new · /sessions · /session · /rename · /fork · /archive · /abort", "",
        "<b>Ассистент</b>", "/remind · /reminders · /remember · /memory · /recall · /about_me", "",
        "<b>Голосовые тексты</b>", "/voice · /story", "",
        "<b>Память</b>", "/memory_status · /memory_pause · /memory_export · /forget", "",
        "<b>Mac</b>", "/calendar · /event · /draft · /mac", "",
        "<b>Автоматизация</b>", "/schedule · /digest", "",
        "Начните текст или голосовое с метки «пост», «анонс», «ответ», «дневник», «календарь» и т. п. Без метки голосовое просто расшифруется.",
      ].join("\n"), { parse_mode: "HTML", reply_markup: persistentKeyboard() });
    });

    this.bot.command("home", async (ctx) => this.showHome(ctx));
    this.bot.command("task", async (ctx) => this.captureCommand(ctx, "task"));
    this.bot.command("inbox", async (ctx) => this.captureCommand(ctx, "capture"));
    this.bot.command("remember", async (ctx) => this.captureCommand(ctx, "memory"));
    this.bot.command("search", async (ctx) => this.captureCommand(ctx, "search"));
    this.bot.command("remind", async (ctx) => this.captureCommand(ctx, "reminder"));
    this.bot.command("tasks", async (ctx) => this.showTasks(ctx));
    this.bot.command("reminders", async (ctx) => this.showReminders(ctx));
    this.bot.command("memory", async (ctx) => this.showMemory(ctx));
    this.bot.command("recall", async (ctx) => this.captureCommand(ctx, "recall"));
    this.bot.command("forget", async (ctx) => this.captureCommand(ctx, "forget"));
    this.bot.command("about_me", async (ctx) => this.showAboutMe(ctx));
    this.bot.command("memory_status", async (ctx) => ctx.reply(this.memory.status(ownerId(ctx))));
    this.bot.command("memory_pause", async (ctx) => this.toggleMemory(ctx));
    this.bot.command("memory_export", async (ctx) => this.exportMemory(ctx));
    this.bot.command("voice", async (ctx) => this.voiceCommand(ctx));
    this.bot.command("story", async (ctx) => this.storyCommand(ctx));

    this.bot.command("chat", async (ctx) => {
      const conversation = await this.conversation(ctx);
      const snapshot = await conversation.start(path.join(this.configuration.dataDirectory, "general-chat"));
      this.persist(ctx, conversation);
      await ctx.reply(`<b>Новый чат без проекта.</b>\n<code>${escape(snapshot.threadId ?? "")}</code>`, { parse_mode: "HTML" });
    });

    this.bot.command("new", async (ctx) => this.chooseProject(ctx));
    this.bot.command("sessions", async (ctx) => this.showThreads(ctx));
    this.bot.command("session", async (ctx) => this.showSession(ctx));
    this.bot.command("rename", async (ctx) => this.renameThread(ctx));
    this.bot.command("fork", async (ctx) => this.forkThread(ctx));
    this.bot.command("archive", async (ctx) => this.archiveThread(ctx));
    this.bot.command("abort", async (ctx) => {
      const context = contextId(ctx);
      this.cancelApprovals(context);
      this.cancelUserQuestion(context);
      await (await this.conversation(ctx)).interrupt();
      await ctx.reply("Текущий ход остановлен.");
    });

    this.bot.command("launch_profiles", async (ctx) => {
      const keyboard = new InlineKeyboard();
      for (const profile of this.configuration.profiles) keyboard.text(profile.title, `profile:${profile.id}`).row();
      await ctx.reply("<b>Профиль для новых тредов</b>", { parse_mode: "HTML", reply_markup: keyboard });
    });

    this.bot.command("mail", async (ctx) => {
      await this.executePrompt(ctx, gmailPrompt("Покажи последнее входящее письмо: отправитель, тема, время и краткое содержание."));
    });
    this.bot.command("calendar", async (ctx) => this.showCalendar(ctx));
    this.bot.command("event", async (ctx) => this.createCalendarEvent(ctx));
    this.bot.command("draft", async (ctx) => this.createMailDraft(ctx));
    this.bot.command("schedule", async (ctx) => this.scheduleCodex(ctx));
    this.bot.command("digest", async (ctx) => this.configureDigest(ctx));
    this.bot.command("mac", async (ctx) => this.openOnMac(ctx));
    this.bot.command("health", async (ctx) => this.health(ctx));

    this.bot.callbackQuery(/^profile:(.+)$/, async (ctx) => {
      const conversation = await this.conversation(ctx);
      const profile = conversation.selectProfile(ctx.match![1]);
      this.persist(ctx, conversation);
      await ctx.answerCallbackQuery({ text: `Выбран: ${profile.title}` });
    });

    this.bot.callbackQuery(/^project:(\d+)$/, async (ctx) => {
      const key = contextId(ctx);
      const projects = this.projectChoices.get(key);
      const project = projects?.[Number(ctx.match![1])];
      if (!project) return ctx.answerCallbackQuery({ text: "Список устарел" });
      const conversation = await this.conversation(ctx);
      const snapshot = await conversation.start(project);
      this.persist(ctx, conversation);
      this.projectChoices.delete(key);
      await ctx.answerCallbackQuery({ text: "Тред создан" });
      await ctx.reply(`<b>${escape(this.projectName(project))}</b>\n<code>${escape(snapshot.threadId ?? "")}</code>`, { parse_mode: "HTML" });
    });

    this.bot.callbackQuery(/^thread:(\d+)$/, async (ctx) => {
      const threads = await this.hub.threads(50);
      const thread = threads[Number(ctx.match![1])];
      if (!thread) return ctx.answerCallbackQuery({ text: "Список устарел" });
      const conversation = await this.conversation(ctx);
      await conversation.resume(thread.id);
      this.persist(ctx, conversation);
      await ctx.answerCallbackQuery({ text: "Тред открыт" });
      await ctx.reply(`<b>${escape(thread.title)}</b>\n<code>${escape(thread.id)}</code>`, { parse_mode: "HTML" });
    });

    this.bot.callbackQuery(/^approve:([^:]+):(once|session|decline|cancel)$/, async (ctx) => {
      const token = ctx.match![1];
      const waiter = this.approvals.get(token);
      if (!waiter || waiter.context !== contextId(ctx)) return ctx.answerCallbackQuery({ text: "Запрос закрыт" });
      this.approvals.delete(token);
      clearTimeout(waiter.timer);
      const action = ctx.match![2];
      const choice: ApprovalChoice = action === "once" ? "accept" : action === "session" ? "acceptForSession" : action as ApprovalChoice;
      waiter.settle(choice);
      await ctx.answerCallbackQuery({ text: approvalResult(choice) });
      if (ctx.callbackQuery.message) await ctx.editMessageText(`<b>${escape(approvalResult(choice))}</b>`, { parse_mode: "HTML" });
    });

    this.bot.callbackQuery(/^task:(start|done|tomorrow):(.+)$/, async (ctx) => this.taskAction(ctx));
    this.bot.callbackQuery(/^task:project:(.+)$/, async (ctx) => this.chooseTaskProject(ctx, ctx.match![1]));
    this.bot.callbackQuery(/^taskproject:(\d+)$/, async (ctx) => this.assignTaskProject(ctx, Number(ctx.match![1])));
    this.bot.callbackQuery(/^event:(confirm|cancel):(.+)$/, async (ctx) => this.confirmCalendarEvent(ctx));
    this.bot.callbackQuery(/^question:([^:]+):(\d+|other)$/, async (ctx) => this.answerUserQuestion(ctx));
    this.bot.callbackQuery("home:task", async (ctx) => {
      this.pending.set(contextId(ctx), "task");
      await ctx.answerCallbackQuery();
      await ctx.reply("Напишите новую задачу.");
    });
    this.bot.callbackQuery("home:tasks", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.showTasks(ctx);
    });
    this.bot.callbackQuery(/^capture:(task|memory|drop):(.+)$/, async (ctx) => this.captureAction(ctx));
    this.bot.callbackQuery(/^alarm:delete:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: this.database.deleteAlarm(ctx.match![1]) ? "Удалено" : "Не найдено" });
    });
    this.bot.callbackQuery(/^memory:delete:(.+)$/, async (ctx) => {
      const deleted = await this.memory.forget(ownerId(ctx), ctx.match![1]) || this.database.forget(ctx.match![1]);
      await ctx.answerCallbackQuery({ text: deleted ? "Удалено" : "Не найдено" });
    });
    this.bot.on(["message:voice", "message:audio"], async (ctx) => this.audioMessage(ctx));
    this.bot.on(["message:document", "message:photo", "message:video"], async (ctx) => this.attachmentMessage(ctx));
    this.bot.on("message:text", async (ctx) => this.textMessage(ctx));
    this.bot.catch((error) => console.error("Telegram update failed", error.error));
  }

  private async audioMessage(ctx: Context): Promise<void> {
    const media = ctx.message?.voice ?? ctx.message?.audio;
    if (!media) return;
    if ((media.file_size ?? 0) > this.configuration.maxUploadBytes) {
      await ctx.reply("Файл слишком большой для распознавания.");
      return;
    }
    const progress = await ctx.reply("🎙 Расшифровываю голосовое…");
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-audio-"));
    const extension = ctx.message?.voice ? ".ogg" : path.extname(ctx.message?.audio?.file_name ?? "") || ".audio";
    const target = path.join(directory, `message${extension}`);
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("Telegram не вернул путь к файлу");
      const response = await fetch(`https://api.telegram.org/file/bot${this.configuration.telegramToken}/${file.file_path}`);
      if (!response.ok) throw new Error(`Не удалось скачать файл: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.configuration.maxUploadBytes) throw new Error("Файл превышает допустимый размер");
      await writeFile(target, bytes);
      const raw = await transcribeAudio(target);
      const forwarded = forwardedSource(ctx);
      const sender = forwarded.sender || [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || undefined;
      const sentAt = forwarded.time || (ctx.message?.date ? ctx.message.date * 1000 : Date.now());
      if (telegramAccessMode(this.configuration, ctx.from?.id) === "transcription-only") {
        await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
        for (const part of textChunks(formatPlainTranscript(raw), TELEGRAM_LIMIT)) {
          const presentation = transcriptionCopyPresentation(part);
          await ctx.reply(presentation.body, {
            ...(presentation.parseMode ? { parse_mode: presentation.parseMode } : {}),
            ...(presentation.keyboard ? { reply_markup: presentation.keyboard } : {}),
          });
        }
        return;
      }
      await this.memory.record({ owner: ownerId(ctx), body: raw, role: "user", kind: "voice", project: this.memoryProject(ctx), source: sender ? `telegram-voice:${sender}` : "telegram-voice" });
      if (forwarded.key) {
        const batchKey = `${contextId(ctx)}:${forwarded.key}`;
        const fragment: ForwardedVoiceFragment = {
          id: String(ctx.message?.message_id ?? randomUUID()),
          sender: sender || "Неизвестный отправитель",
          senderKey: forwarded.key,
          sentAt,
          durationSeconds: media.duration ?? 0,
          transcript: raw,
          progressMessageId: progress.message_id,
          chatId: ctx.chat!.id,
          messageThreadId: ctx.message?.message_thread_id,
        };
        const count = this.forwardedVoiceBatcher.add(batchKey, fragment);
        await ctx.api.editMessageText(ctx.chat!.id, progress.message_id,
          `🎙 Фрагмент ${count} принят · собираю пересылки ещё 45 секунд…`).catch(() => undefined);
        return;
      }
      const command = parseSpokenVoiceCommand(raw);
      if (await this.handleLabeledCommand(ctx, command, raw, sentAt, sender, progress.message_id)) return;
      await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
      for (const part of htmlChunks(structureTranscript(command.content, { sender, sentAt }), TELEGRAM_LIMIT)) {
        await ctx.reply(part, { parse_mode: "HTML" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, `Не удалось расшифровать: ${message}`).catch(() => undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private enqueueForwardedVoiceBatch(batch: ForwardedVoiceBatch): void {
    const previous = this.forwardedVoiceFlushes.get(batch.key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.flushForwardedVoiceBatch(batch))
      .catch((error) => console.error("Forwarded voice batch failed", error));
    this.forwardedVoiceFlushes.set(batch.key, next);
    void next.finally(() => {
      if (this.forwardedVoiceFlushes.get(batch.key) === next) this.forwardedVoiceFlushes.delete(batch.key);
    });
  }

  private async flushForwardedVoiceBatch(batch: ForwardedVoiceBatch): Promise<void> {
    const fragments = batch.fragments;
    const target = fragments.at(-1);
    if (!target) return;
    const progressIds = [...new Set(fragments.map((fragment) => fragment.progressMessageId))];
    for (const messageId of progressIds.slice(0, -1)) {
      await this.bot.api.deleteMessage(target.chatId, messageId).catch(() => undefined);
    }
    const activeProgressId = progressIds.at(-1);
    if (activeProgressId !== undefined) {
      await this.bot.api.editMessageText(target.chatId, activeProgressId,
        fragments.length > 1 ? `🧠 Объединяю ${fragments.length} голосовых по смыслу…` : "📝 Оформляю расшифровку…").catch(() => undefined);
    }
    try {
      if (fragments.length === 1) {
        if (activeProgressId !== undefined) await this.bot.api.deleteMessage(target.chatId, activeProgressId).catch(() => undefined);
        for (const part of htmlChunks(structureTranscript(target.transcript, { sender: target.sender, sentAt: target.sentAt }), TELEGRAM_LIMIT)) {
          await this.bot.api.sendMessage(target.chatId, part, telegramHtmlOptions(target.messageThreadId));
        }
        return;
      }
      let body: string;
      try {
        body = await this.forwardedVoiceEditor.edit(batch.key, fragments);
      } catch (error) {
        console.error("Forwarded voice editing failed", error);
        body = fragments.map((fragment) => fragment.transcript).join("\n\n");
      }
      const markdown = `${forwardedVoiceHeading(fragments)}\n\n${body}`;
      await this.memory.record({ owner: String(target.chatId), body: markdown, role: "assistant", kind: "response",
        source: "forwarded-voice-batch" });
      if (activeProgressId !== undefined) await this.bot.api.deleteMessage(target.chatId, activeProgressId).catch(() => undefined);
      for (const chunk of telegramMarkdownChunks(markdown, TELEGRAM_LIMIT - 100)) {
        try {
          await this.bot.api.sendMessage(target.chatId, chunk.html, telegramHtmlOptions(target.messageThreadId));
        } catch {
          await this.bot.api.sendMessage(target.chatId, chunk.plain, telegramPlainOptions(target.messageThreadId));
        }
      }
    } catch (error) {
      const message = `Не удалось собрать пересланные голосовые: ${errorMessage(error)}`;
      if (activeProgressId !== undefined) {
        await this.bot.api.editMessageText(target.chatId, activeProgressId, message).catch(() => undefined);
      } else {
        await this.bot.api.sendMessage(target.chatId, message, telegramPlainOptions(target.messageThreadId)).catch(() => undefined);
      }
    }
  }

  private async handleLabeledCommand(ctx: Context, command: SpokenVoiceCommand, raw: string, sentAt: number,
    sender?: string, existingProgressId?: number): Promise<boolean> {
    if (!command.label) return false;
    const clearProgress = async (): Promise<void> => {
      if (existingProgressId !== undefined) {
        await ctx.api.deleteMessage(ctx.chat!.id, existingProgressId).catch(() => undefined);
      }
    };
    if (!command.content && command.kind === "diary") {
      await clearProgress();
      await this.showTodayDiary(ctx, sentAt);
      return true;
    }
    if (!command.content) {
      await clearProgress();
      await ctx.reply(`После метки «${escape(command.label)}» нужен текст или поручение.`);
      return true;
    }
    if (command.kind === "transcript") {
      await clearProgress();
      for (const part of htmlChunks(structureTranscript(command.content, { sender, sentAt }), TELEGRAM_LIMIT)) {
        await ctx.reply(part, { parse_mode: "HTML" });
      }
      return true;
    }
    if (command.kind === "task" || command.kind === "reminder" || command.kind === "inbox" || command.kind === "memory" || command.kind === "calendar") {
      await clearProgress();
      if (command.kind === "task") {
        const task = this.database.createTask({ owner: ownerId(ctx), title: oneLine(command.content, 140), prompt: command.content });
        await ctx.reply(taskCard(task), { parse_mode: "HTML", reply_markup: taskKeyboard(task) });
      } else if (command.kind === "reminder") {
        await this.acceptPending(ctx, "reminder", command.content);
      } else if (command.kind === "inbox") {
        await this.acceptPending(ctx, "capture", command.content);
      } else if (command.kind === "memory") {
        await this.acceptPending(ctx, "memory", command.content);
      } else {
        const calendarRequest = `календарь ${command.content}`;
        if (localIntent(calendarRequest) === "calendar-list") await this.showCalendar(ctx);
        else await this.offerCalendarEvent(ctx, `создай событие в календаре ${command.content}`);
      }
      return true;
    }
    if (isStyleWritingKind(command.kind)) {
      const label = styleWritingLabel(command.kind);
      let progressId = existingProgressId;
      if (progressId === undefined) progressId = (await ctx.reply(`✍️ Codex пишет · ${label}…`)).message_id;
      else await ctx.api.editMessageText(ctx.chat!.id, progressId, `✍️ Codex пишет · ${label}…`).catch(() => undefined);
      let edited: EditedVoiceEntry;
      try {
        edited = await this.voiceEditor.compose(contextId(ctx), command.kind, command.content);
      } catch (error) {
        await ctx.api.deleteMessage(ctx.chat!.id, progressId).catch(() => undefined);
        await ctx.reply(`<b>⚠️ Не удалось подготовить ${escape(label.toLocaleLowerCase("ru-RU"))}.</b>\n${escape(errorMessage(error))}`, {
          parse_mode: "HTML",
        });
        if (existingProgressId !== undefined) {
          for (const part of htmlChunks(structureTranscript(command.content, { sender, sentAt }), TELEGRAM_LIMIT)) {
            await ctx.reply(part, { parse_mode: "HTML" });
          }
        }
        return true;
      }
      await this.memory.record({ owner: ownerId(ctx), body: edited.markdown, role: "assistant", kind: "response",
        project: this.memoryProject(ctx), source: `tagged-${command.kind}-draft` });
      await ctx.api.deleteMessage(ctx.chat!.id, progressId).catch(() => undefined);
      await ctx.reply(`<b>✅ ${escape(label)} готов</b>`, { parse_mode: "HTML" });
      await sendTelegramMarkdown(ctx.api, ctx.chat!.id, edited.markdown, TELEGRAM_LIMIT - 100);
      return true;
    }
    if (command.kind !== "diary" && command.kind !== "story") return false;

    const writingMode = command.kind;
    const stored = this.database.voiceWritingSettings(contextId(ctx), ownerId(ctx));
    const settings: VoiceWritingSettings = {
      context: contextId(ctx), owner: ownerId(ctx), mode: writingMode,
      storyTitle: writingMode === "story" ? stored.storyTitle : undefined, changedAt: Date.now(),
    };
    if (settings.mode === "story" && !settings.storyTitle) {
      await clearProgress();
      await ctx.reply("Сначала задайте название цикла: /story Название цикла. Затем начинайте сообщение со слова «рассказ».");
      return true;
    }
    let progressId = existingProgressId;
    if (progressId === undefined) progressId = (await ctx.reply(`✍️ Codex редактирует · ${voiceModeLabel(settings)}…`)).message_id;
    else await ctx.api.editMessageText(ctx.chat!.id, progressId, `✍️ Codex редактирует · ${voiceModeLabel(settings)}…`).catch(() => undefined);
    const previous = settings.mode === "story" && settings.storyTitle
      ? await this.voiceArchive.previousStoryExcerpt(settings.storyTitle) : undefined;
    let edited: EditedVoiceEntry;
    try {
      edited = await this.voiceEditor.edit(contextId(ctx), writingMode, command.content, settings.storyTitle, previous);
    } catch (error) {
      const rawPath = await this.voiceArchive.saveRaw(writingMode, raw, sentAt, settings.storyTitle);
      await ctx.api.deleteMessage(ctx.chat!.id, progressId).catch(() => undefined);
      await ctx.reply(["<b>⚠️ Исходный текст сохранён, но Codex не смог его отредактировать.</b>", escape(errorMessage(error)),
        `Исходник: <code>${escape(rawPath)}</code>`].join("\n"), { parse_mode: "HTML" });
      for (const part of htmlChunks(structureTranscript(command.content, { sender, sentAt }), TELEGRAM_LIMIT)) {
        await ctx.reply(part, { parse_mode: "HTML" });
      }
      return true;
    }
    const saved = await this.voiceArchive.save(writingMode, edited.markdown, raw, sentAt, settings.storyTitle);
    let noteResult = "Apple Notes обновлены";
    try {
      await appendAppleNote({
        folder: saved.notesFolder, title: saved.notesTitle, html: saved.notesHtml,
        sectionMarker: saved.notesSectionMarker, continuationHtml: saved.notesContinuationHtml,
      });
    } catch (error) {
      noteResult = `Apple Notes не обновлены: ${errorMessage(error)}`;
    }
    await this.memory.record({ owner: ownerId(ctx), body: edited.markdown, role: "assistant", kind: "response",
      project: this.memoryProject(ctx), source: `tagged-${writingMode}-edited` });
    await ctx.api.deleteMessage(ctx.chat!.id, progressId).catch(() => undefined);
    const confirmation = [
      `<b>✅ ${escape(voiceModeLabel(settings))}: сохранено</b>`,
      `Заметка: <b>${escape(saved.notesTitle)}</b>`,
      escape(noteResult),
      `Резервная копия: <code>${escape(saved.polishedPath)}</code>`,
    ].join("\n");
    await ctx.reply(confirmation, { parse_mode: "HTML" });
    await sendTelegramMarkdown(ctx.api, ctx.chat!.id, edited.markdown, TELEGRAM_LIMIT - 100);
    return true;
  }

  private async attachmentMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message) return;
    const source = forwardedSource(ctx);
    const name = message.document?.file_name || message.video?.file_name || (message.photo ? "Фотография" : "Файл");
    const body = [name, message.caption].filter(Boolean).join("\n");
    const captured = this.database.capture({ owner: ownerId(ctx), kind: message.photo ? "photo" : message.video ? "video" : "document", body, sender: source.sender, sourceTime: source.time });
    await this.memory.record({ owner: ownerId(ctx), body, role: "action", kind: "action", project: this.memoryProject(ctx), source: "telegram-attachment" });
    await ctx.reply(`${captureCard(captured)}\n\n<i>Codex-тред не запускался.</i>`, { parse_mode: "HTML", reply_markup: captureKeyboard(captured.id) });
  }

  private async showTodayDiary(ctx: Context, value = Date.now()): Promise<void> {
    const day = await this.voiceArchive.diaryDay(value);
    if (!day) {
      await ctx.reply("За сегодня в дневнике пока нет записей. Начните сообщение со слова «дневник» или «заметки» и продолжайте текст.");
      return;
    }
    await sendTelegramMarkdown(ctx.api, ctx.chat!.id, day.markdown, TELEGRAM_LIMIT - 100);
    await ctx.replyWithDocument(new InputFile(Buffer.from(day.markdown, "utf8"), day.fileName), {
      caption: "Markdown дневника за сегодня",
    });
  }

  private async textMessage(ctx: Context): Promise<void> {
    const text = ctx.message?.text?.trim();
    if (!text || text.startsWith("/")) return;
    const key = contextId(ctx);
    const questionToken = this.userQuestionByContext.get(key);
    const question = questionToken ? this.userQuestions.get(questionToken) : undefined;
    if (question) {
      if (!question.waitingText && !question.acceptsText) {
        await ctx.reply("Выберите один из вариантов кнопкой.");
        return;
      }
      await this.rememberIncoming(ctx, text);
      this.finishUserQuestion(questionToken!, [text]);
      await ctx.reply("Ответ передан в текущую задачу.");
      return;
    }
    const pending = this.pending.get(key);
    if (pending) {
      this.pending.delete(key);
      if (pending !== "memory") await this.rememberIncoming(ctx, text);
      await this.acceptPending(ctx, pending, text);
      return;
    }
    if (ctx.message?.forward_origin) {
      await this.rememberIncoming(ctx, text);
      const source = forwardedSource(ctx);
      const captured = this.database.capture({ owner: ownerId(ctx), kind: "forward", body: text, sender: source.sender, sourceTime: source.time });
      await ctx.reply(captureCard(captured), { parse_mode: "HTML", reply_markup: captureKeyboard(captured.id) });
      return;
    }
    const labeled = parseSpokenVoiceCommand(text);
    if (labeled.label) {
      const action = labeled.kind === "calendar" || labeled.kind === "task" || labeled.kind === "reminder"
        || labeled.kind === "inbox" || labeled.kind === "memory";
      await this.rememberIncoming(ctx, text, action ? "action" : "message");
      const sender = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || undefined;
      const sentAt = ctx.message?.date ? ctx.message.date * 1000 : Date.now();
      if (await this.handleLabeledCommand(ctx, labeled, text, sentAt, sender)) return;
    }
    const intent = localIntent(text);
    let localFallback = false;
    if (intent) {
      if (await this.handleLocalIntent(ctx, text)) {
        await this.rememberIncoming(ctx, text, "action");
        return;
      }
      localFallback = true;
    }
    const conversation = await this.conversation(ctx);
    const project = conversation.snapshot().workspace;
    const augmented = await this.memory.augmentPrompt(ownerId(ctx), text, project);
    await this.memory.record({ owner: ownerId(ctx), body: text, role: "user", kind: "message", project, source: "telegram-text" });
    const routed = looksLikeMail(text) ? gmailPrompt(augmented)
      : quietCodexPrompt(localFallback ? localCommandFallbackPrompt(augmented) : augmented);
    if (conversation.snapshot().running) {
      await conversation.steer(routed);
      await ctx.reply("↪️ Уточнение добавлено в текущий ход.");
      return;
    }
    await this.executePrompt(ctx, routed);
  }

  private async handleLocalIntent(ctx: Context, text: string): Promise<boolean> {
    const intent = localIntent(text);
    if (!intent) return false;
    if (intent === "calendar-list") {
      await this.showCalendar(ctx);
      return true;
    }
    if (intent === "calendar-create") {
      await this.offerCalendarEvent(ctx, text);
      return true;
    }
    const parsed = understandAlarm(text) ?? await this.parseTemporalWithCodex(ctx, text, "reminder");
    if (!parsed) {
      await ctx.reply("Не удалось надёжно определить дату и время. Уточните, например: «напоминание завтра в 10:00 позвонить Анне».");
      return true;
    }
    const label = parsed.label === "Напоминание" && /будильник/i.test(text) ? "Будильник" : parsed.label;
    let systemAlarm = true;
    try {
      await addSystemAlarm(parsed.at);
    } catch (error) {
      systemAlarm = false;
      console.error("System alarm creation failed", error);
    }
    const alarm = this.database.createAlarm({ owner: ownerId(ctx), label, nextAt: parsed.at, cadence: parsed.cadence });
    const status = [systemAlarm ? "✅ Системный будильник на Mac создан" : "⚠️ Системный будильник создать не удалось",
      "✅ Напоминание в Telegram установлено"];
    await ctx.reply(`⏰ <b>${escape(alarm.label)}</b>\n${formatDate(alarm.nextAt)}\n\n${status.join("\n")}`, {
      parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Удалить TG-напоминание", `alarm:delete:${alarm.id}`),
    });
    return true;
  }

  private async executePrompt(ctx: Context, prompt: string): Promise<void> {
    const conversation = await this.conversation(ctx);
    const view = new TelegramTurnView(ctx, (request) => this.askApproval(ctx, request),
      (request) => this.askUserInput(ctx, request), this.configuration.showUsage);
    try {
      await conversation.run(prompt, view);
      await view.finish();
      this.persist(ctx, conversation);
      const answer = view.content();
      if (answer) await this.memory.record({ owner: ownerId(ctx), body: answer, role: "assistant", kind: "response", project: conversation.snapshot().workspace, source: "codex-final" });
    } catch (error) {
      await view.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async askUserInput(ctx: Context, prompt: UserInputPrompt): Promise<UserInputAnswers> {
    const result: UserInputAnswers = {};
    for (const question of prompt.questions) {
      if (question.isSecret) {
        await ctx.reply(`🔐 <b>${escape(question.header || "Секретный ввод")}</b>\nСекрет нельзя безопасно запросить через Telegram. Выполните этот шаг на Mac.`, { parse_mode: "HTML" });
        result[question.id] = { answers: [] };
        continue;
      }
      result[question.id] = { answers: await this.askOneQuestion(ctx, question, prompt.autoResolutionMs) };
    }
    return result;
  }

  private async askOneQuestion(ctx: Context, question: UserInputQuestion, autoResolutionMs?: number): Promise<string[]> {
    const context = contextId(ctx);
    this.cancelUserQuestion(context);
    const token = randomUUID().slice(0, 10);
    const options = (question.options ?? []).map((option) => option.label);
    const keyboard = new InlineKeyboard();
    options.forEach((label, index) => keyboard.text(label, `question:${token}:${index}`).row());
    if (question.isOther) keyboard.text("Другой ответ ✍️", `question:${token}:other`);
    const timeout = Math.min(Math.max(autoResolutionMs ?? 10 * 60_000, 5_000), 10 * 60_000);
    const answer = new Promise<string[]>((settle) => {
      const timer = setTimeout(() => this.finishUserQuestion(token, []), timeout);
      this.userQuestions.set(token, {
        context, options, acceptsText: question.isOther || !options.length, waitingText: !options.length, settle, timer,
      });
      this.userQuestionByContext.set(context, token);
    });
    const details = (question.options ?? []).map((option) => option.description ? `• <b>${escape(option.label)}</b> — ${escape(option.description)}` : "").filter(Boolean);
    await ctx.reply([`<b>❓ ${escape(question.header || "Нужен ответ")}</b>`, escape(question.question), ...details].join("\n\n"), {
      parse_mode: "HTML", reply_markup: keyboard,
    });
    return answer;
  }

  private async answerUserQuestion(ctx: Context): Promise<void> {
    const token = ctx.match![1];
    const selection = ctx.match![2];
    const waiter = this.userQuestions.get(token);
    if (!waiter || waiter.context !== contextId(ctx)) return void await ctx.answerCallbackQuery({ text: "Вопрос уже закрыт" });
    if (selection === "other") {
      waiter.waitingText = true;
      await ctx.answerCallbackQuery({ text: "Напишите ответ" });
      await ctx.reply("Отправьте свой ответ одним сообщением.");
      return;
    }
    const answer = waiter.options[Number(selection)];
    if (!answer) return void await ctx.answerCallbackQuery({ text: "Вариант устарел" });
    this.finishUserQuestion(token, [answer]);
    await ctx.answerCallbackQuery({ text: `Ответ: ${answer}` });
    if (ctx.callbackQuery?.message) await ctx.editMessageText(`✅ Ответ передан: <b>${escape(answer)}</b>`, { parse_mode: "HTML" });
  }

  private finishUserQuestion(token: string, answers: string[]): void {
    const waiter = this.userQuestions.get(token);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.userQuestions.delete(token);
    if (this.userQuestionByContext.get(waiter.context) === token) this.userQuestionByContext.delete(waiter.context);
    waiter.settle(answers);
  }

  private cancelUserQuestion(context: string): void {
    const token = this.userQuestionByContext.get(context);
    if (token) this.finishUserQuestion(token, []);
  }

  private async askApproval(ctx: Context, prompt: ApprovalPrompt): Promise<ApprovalChoice> {
    const token = randomUUID().slice(0, 10);
    const keyboard = new InlineKeyboard()
      .text("✅ Один раз", `approve:${token}:once`).text("🔁 На сессию", `approve:${token}:session`).row()
      .text("⛔ Отклонить", `approve:${token}:decline`).text("✖️ Отменить", `approve:${token}:cancel`);
    return new Promise<ApprovalChoice>((settle) => {
      const timer = setTimeout(() => { this.approvals.delete(token); settle("decline"); }, 10 * 60_000);
      this.approvals.set(token, { context: contextId(ctx), settle, timer });
      void ctx.reply(approvalCard(prompt), { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {
        clearTimeout(timer); this.approvals.delete(token); settle("decline");
      });
    });
  }

  private async conversation(ctx: Context): Promise<Conversation> {
    const key = contextId(ctx);
    const saved = this.database.conversation(key);
    return this.hub.conversation(key, saved ? {
      threadId: saved.threadId, workspace: saved.workspace, model: saved.model, effort: saved.effort, profileId: saved.profileId,
    } : undefined);
  }

  private persist(ctx: Context, conversation: Conversation): void {
    const snapshot = conversation.snapshot();
    this.database.saveConversation({
      context: contextId(ctx), threadId: snapshot.threadId, workspace: snapshot.workspace,
      model: snapshot.model, effort: snapshot.effort, profileId: snapshot.profileId,
    });
  }

  private async showHome(ctx: Context): Promise<void> {
    const owner = ownerId(ctx);
    const counts = this.database.counts(owner);
    const inbox = this.database.captures(owner, "new", 100).length;
    const alarms = this.database.alarms(owner).slice(0, 3);
    const text = ["<b>🏠 Рабочий центр</b>", "", `▶️ В работе: <b>${counts.running}</b>`, `❓ Нужен ответ: <b>${counts.waiting}</b>`,
      `⏳ В очереди: <b>${counts.queued}</b>`, `📋 Запланировано: <b>${counts.todo}</b>`, `📥 Инбокс: <b>${inbox}</b>`,
      "🎙 Голосовые: <b>метка в начале сообщения</b>",
      ...(alarms.length ? ["", "<b>Напоминания</b>", ...alarms.map((alarm) => `⏰ ${escape(alarm.label)} · ${formatDate(alarm.nextAt)}`)] : [])].join("\n");
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: homeKeyboard() });
  }

  private async captureCommand(ctx: Context, kind: PendingInput): Promise<void> {
    const command = ctx.message?.text?.replace(/^\/\w+(?:@\w+)?\s*/i, "").trim() || "";
    if (command) return this.acceptPending(ctx, kind, command);
    this.pending.set(contextId(ctx), kind);
    const prompts: Record<PendingInput, string> = {
      task: "Напишите новую задачу.", capture: "Что добавить в инбокс?", memory: "Что запомнить?",
      search: "Что найти?", reminder: "Когда и о чём напомнить?", recall: "Что вспомнить?", forget: "Пришлите ID записи, которую нужно забыть.",
      story: "Напишите название цикла рассказов.",
    };
    await ctx.reply(prompts[kind]);
  }

  private async acceptPending(ctx: Context, kind: PendingInput, value: string): Promise<void> {
    const owner = ownerId(ctx);
    if (kind === "task") {
      const task = this.database.createTask({ owner, title: oneLine(value, 140), prompt: value });
      await ctx.reply(taskCard(task), { parse_mode: "HTML", reply_markup: taskKeyboard(task) });
    } else if (kind === "capture") {
      const captured = this.database.capture({ owner, kind: value.includes("http") ? "link" : "text", body: value });
      await ctx.reply(captureCard(captured), { parse_mode: "HTML", reply_markup: captureKeyboard(captured.id) });
    } else if (kind === "memory") {
      const event = await this.memory.record({ owner, body: value, role: "user", kind: "explicit", project: this.memoryProject(ctx), source: "telegram-remember" });
      await ctx.reply(event ? `📚 Сохранено в память.\nID: <code>${event.id}</code>` : "🔐 Не сохранено: сообщение похоже на секрет или память приостановлена.", { parse_mode: "HTML" });
    } else if (kind === "search") {
      const hits = this.database.search(owner, value, 20);
      const threads = await this.hub.threads(10, value).catch(() => []);
      await ctx.reply(searchResults(value, hits, threads), { parse_mode: "HTML" });
    } else if (kind === "recall") {
      const hits = await this.memory.recall(owner, value, this.memoryProject(ctx), 10);
      await ctx.reply(recallResults(value, hits), { parse_mode: "HTML" });
    } else if (kind === "forget") {
      await ctx.reply(await this.memory.forget(owner, value.trim()) ? "🗑 Запись удалена из памяти и будет удалена из индекса." : "Запись не найдена.");
    } else if (kind === "story") {
      const settings = this.database.setVoiceWritingSettings({ context: contextId(ctx), owner, mode: "story", storyTitle: value });
      await ctx.reply(`Цикл рассказов сохранён: <b>${escape(settings.storyTitle ?? value)}</b>\nТеперь начинайте нужные голосовые со слова «рассказ».`, { parse_mode: "HTML" });
    } else {
      const parsed = understandAlarm(value) ?? await this.parseTemporalWithCodex(ctx, value, "reminder");
      if (!parsed) return void await ctx.reply("Не понял время. Например: завтра в 10 позвонить Анне.");
      const alarm = this.database.createAlarm({ owner, label: parsed.label, nextAt: parsed.at, cadence: parsed.cadence });
      await ctx.reply(`⏰ <b>${escape(alarm.label)}</b>\n${formatDate(alarm.nextAt)}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Удалить", `alarm:delete:${alarm.id}`) });
    }
  }

  private async voiceCommand(ctx: Context): Promise<void> {
    await ctx.reply(spokenVoiceHelp(), { parse_mode: "HTML" });
  }

  private async storyCommand(ctx: Context): Promise<void> {
    const title = commandArgument(ctx);
    if (!title) return this.captureCommand(ctx, "story");
    const settings = this.database.setVoiceWritingSettings({ context: contextId(ctx), owner: ownerId(ctx), mode: "story", storyTitle: title });
    await ctx.reply(`Цикл рассказов сохранён: <b>${escape(settings.storyTitle ?? title)}</b>\nТеперь начинайте нужные голосовые со слова «рассказ».`, { parse_mode: "HTML" });
  }

  private async showTasks(ctx: Context): Promise<void> {
    const tasks = this.database.tasks(ownerId(ctx), ["running", "waiting", "queued", "todo"], 20);
    if (!tasks.length) return void await ctx.reply("Активных задач нет.");
    for (const task of tasks) await ctx.reply(taskCard(task), { parse_mode: "HTML", reply_markup: taskKeyboard(task) });
  }

  private async showReminders(ctx: Context): Promise<void> {
    const alarms = this.database.alarms(ownerId(ctx));
    if (!alarms.length) return void await ctx.reply("Активных напоминаний нет.");
    for (const alarm of alarms) await ctx.reply(`⏰ <b>${escape(alarm.label)}</b>\n${formatDate(alarm.nextAt)}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Удалить", `alarm:delete:${alarm.id}`) });
  }

  private async showMemory(ctx: Context): Promise<void> {
    const owner = ownerId(ctx);
    const events = this.database.memoryEvents(owner, { limit: 20 }).filter((event) => event.kind === "explicit");
    const legacy = this.database.memories(owner);
    if (!events.length && !legacy.length) return void await ctx.reply(`Память пуста.\n\n${this.memory.status(owner)}`);
    for (const event of events) await ctx.reply(`📚 ${escape(oneLine(event.body, 600))}\n<code>${event.id}</code>`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Удалить", `memory:delete:${event.id}`) });
    for (const note of legacy) await ctx.reply(`📚 ${escape(oneLine(note.body, 600))}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Удалить", `memory:delete:${note.id}`) });
  }

  private async showAboutMe(ctx: Context): Promise<void> {
    const hits = await this.memory.recall(ownerId(ctx), "личные факты предпочтения цели работа проекты привычки обо мне", undefined, 10);
    await ctx.reply(hits.length ? `<b>Что я помню о вас</b>\n\n${hits.map((hit) => `• ${escape(oneLine(hit.body, 500))}`).join("\n")}` : "Пока недостаточно данных для профиля. Используйте /remember для важных фактов.", { parse_mode: "HTML" });
  }

  private async toggleMemory(ctx: Context): Promise<void> {
    const owner = ownerId(ctx);
    const argument = commandArgument(ctx).toLocaleLowerCase("ru-RU");
    const paused = /^(?:on|вкл|включить)$/.test(argument) ? false : /^(?:off|выкл|выключить|pause)$/.test(argument) ? true : !this.memory.paused(owner);
    this.memory.setPaused(owner, paused);
    await ctx.reply(paused ? "⏸ Память приостановлена: новые сообщения не сохраняются и recall отключён." : "▶️ Память включена.");
  }

  private async exportMemory(ctx: Context): Promise<void> {
    const owner = ownerId(ctx);
    const data = this.memory.export(owner);
    await ctx.replyWithDocument(new InputFile(Buffer.from(data, "utf8"), `memory-export-${new Date().toISOString().slice(0, 10)}.json`), { caption: "Экспорт долговременной памяти" });
  }

  private async showCalendar(ctx: Context): Promise<void> {
    try {
      const entries = await upcomingCalendar();
      if (!entries.length) return void await ctx.reply("В ближайшие семь дней событий нет.");
      const lines = ["<b>🗓 Ближайшие события</b>", "", ...entries.map((entry) => `• <b>${escape(entry.title)}</b>\n${escape(entry.start)} · ${escape(entry.calendar)}`)];
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    } catch (error) {
      await ctx.reply(`Не удалось прочитать Apple Calendar: ${errorMessage(error)}`);
    }
  }

  private async createCalendarEvent(ctx: Context): Promise<void> {
    const input = commandArgument(ctx);
    if (!input) return void await ctx.reply("Формат: <code>/event завтра в 15:00 Созвон с Анной</code>", { parse_mode: "HTML" });
    await this.offerCalendarEvent(ctx, input);
  }

  private async offerCalendarEvent(ctx: Context, input: string, replyOnFailure = true): Promise<boolean> {
    const parsed = understandAlarm(input) ?? await this.parseTemporalWithCodex(ctx, input, "calendar");
    if (!parsed) {
      if (replyOnFailure) await ctx.reply("Не удалось надёжно определить событие. Уточните дату, время и название, например: «календарь в четверг в 19:00 Концерт».");
      return false;
    }
    const title = normalizeCalendarTitle(parsed.label);
    const token = randomUUID().slice(0, 10);
    this.calendarEvents.set(token, { title, start: parsed.at });
    const keyboard = new InlineKeyboard().text("✅ Создать", `event:confirm:${token}`).text("Отмена", `event:cancel:${token}`);
    await ctx.reply(`Создать событие?\n<b>${escape(title)}</b>\n${formatDate(parsed.at)}`, { parse_mode: "HTML", reply_markup: keyboard });
    return true;
  }

  private async parseTemporalWithCodex(ctx: Context, input: string, purpose: "calendar" | "reminder"): Promise<ParsedAlarm | null> {
    const profileId = this.configuration.profiles.find((profile) => profile.id === "readonly")?.id
      ?? this.configuration.defaultProfile;
    const conversation = await this.hub.conversation(`temporal-parser:${contextId(ctx)}`, {
      workspace: this.configuration.dataDirectory, model: this.configuration.defaultModel, profileId,
    });
    const observer = new TextOnlyObserver();
    const prompt = [
      "Ты — строгий парсер русскоязычной команды. Не выполняй действие и не используй инструменты.",
      `Назначение: ${purpose === "calendar" ? "событие календаря" : "напоминание"}.`,
      `Текущее локальное время Europe/Moscow: ${moscowIso(new Date())}.`,
      "Извлеки ближайшие будущие дату и время, короткое название без командных слов и повторяемость.",
      "Если назван день недели без даты, выбери ближайший будущий такой день. Если данных недостаточно или есть неоднозначность, верни ровно {\"error\":\"clarification_needed\"}.",
      "Иначе верни только JSON без Markdown: {\"dateTime\":\"ISO-8601 с явным +03:00\",\"title\":\"название\",\"cadence\":\"once|daily|weekdays|weekly\"}.",
      `Команда: ${JSON.stringify(input)}`,
    ].join("\n\n");
    try {
      await conversation.run(prompt, observer);
      return parseTemporalCodexResponse(observer.content());
    } catch (error) {
      console.error("Codex temporal parsing failed", error);
      return null;
    }
  }

  private async confirmCalendarEvent(ctx: Context): Promise<void> {
    const action = ctx.match![1];
    const token = ctx.match![2];
    const event = this.calendarEvents.get(token);
    if (!event) return void await ctx.answerCallbackQuery({ text: "Запрос устарел" });
    this.calendarEvents.delete(token);
    if (action === "cancel") {
      await ctx.answerCallbackQuery({ text: "Отменено" });
      if (ctx.callbackQuery?.message) await ctx.editMessageText("Создание события отменено.");
      return;
    }
    try {
      await addCalendarEvent(event.title, event.start);
      await ctx.answerCallbackQuery({ text: "Событие создано" });
      if (ctx.callbackQuery?.message) await ctx.editMessageText(`✅ Событие создано\n<b>${escape(event.title)}</b>\n${formatDate(event.start)}`, { parse_mode: "HTML" });
    } catch (error) {
      await ctx.answerCallbackQuery({ text: "Ошибка" });
      await ctx.reply(`Не удалось создать событие: ${errorMessage(error)}`);
    }
  }

  private async createMailDraft(ctx: Context): Promise<void> {
    const input = commandArgument(ctx);
    const [address, subject, ...body] = input.split("|").map((part) => part.trim());
    if (!address || !subject || !body.join("|").trim()) {
      return void await ctx.reply("Формат: <code>/draft адрес | тема | текст письма</code>\nСоздаётся только черновик — отправки нет.", { parse_mode: "HTML" });
    }
    try {
      await makeMailDraft(address, subject, body.join("|").trim());
      await ctx.reply(`✉️ Черновик создан в Apple Mail\nКому: <code>${escape(address)}</code>\nТема: <b>${escape(subject)}</b>`, { parse_mode: "HTML" });
    } catch (error) {
      await ctx.reply(`Не удалось создать черновик: ${errorMessage(error)}`);
    }
  }

  private async scheduleCodex(ctx: Context): Promise<void> {
    const input = commandArgument(ctx);
    if (!input) return void await ctx.reply("Формат: <code>/schedule завтра в 10 проверить сборку проекта</code>", { parse_mode: "HTML" });
    const parsed = understandAlarm(input);
    if (!parsed) return void await ctx.reply("Не понял время запуска.");
    const current = await this.conversation(ctx);
    const alarm = this.database.createAlarm({
      owner: ownerId(ctx), label: parsed.label, nextAt: parsed.at, cadence: parsed.cadence,
      mode: "codex", prompt: parsed.label, project: current.snapshot().workspace,
    });
    await ctx.reply(`🤖 Задача Codex запланирована\n<b>${escape(alarm.label)}</b>\n${formatDate(alarm.nextAt)}`, { parse_mode: "HTML" });
  }

  private async configureDigest(ctx: Context): Promise<void> {
    const input = commandArgument(ctx).toLocaleLowerCase("ru-RU");
    const owner = ownerId(ctx);
    const existing = this.database.alarms(owner).filter((alarm) => alarm.mode === "digest-morning" || alarm.mode === "digest-evening");
    if (input === "off" || input === "выкл") {
      existing.forEach((alarm) => this.database.deleteAlarm(alarm.id));
      await ctx.reply("Дайджесты выключены.");
      return;
    }
    if (!input || input === "status") {
      await ctx.reply(existing.length ? `Дайджесты включены: ${existing.map((alarm) => formatDate(alarm.nextAt)).join(", ")}` : "Дайджесты выключены. Включить: /digest on");
      return;
    }
    if (input !== "on" && input !== "вкл") return void await ctx.reply("Используйте <code>/digest on</code>, <code>/digest off</code> или <code>/digest status</code>.", { parse_mode: "HTML" });
    existing.forEach((alarm) => this.database.deleteAlarm(alarm.id));
    const morning = nextLocalTime(9, 0);
    const evening = nextLocalTime(21, 0);
    this.database.createAlarm({ owner, label: "Утренний дайджест", nextAt: morning, cadence: "daily", mode: "digest-morning" });
    this.database.createAlarm({ owner, label: "Итог дня", nextAt: evening, cadence: "daily", mode: "digest-evening" });
    await ctx.reply("✅ Дайджесты включены: утром в 09:00 и общий итог дня в 21:00.");
  }

  private async openOnMac(ctx: Context): Promise<void> {
    const snapshot = (await this.conversation(ctx)).snapshot();
    if (!snapshot.threadId) return void await ctx.reply("Сначала откройте или создайте Codex-тред.");
    try {
      const command = await activateCodexWithResume(snapshot.workspace, snapshot.threadId);
      await ctx.reply(`💻 Codex открыт на Mac. Команда продолжения скопирована:\n<code>${escape(command)}</code>`, { parse_mode: "HTML" });
    } catch (error) {
      await ctx.reply(`Не удалось открыть Codex: ${errorMessage(error)}`);
    }
  }

  private async chooseProject(ctx: Context): Promise<void> {
    const projects = await this.recentProjects();
    if (!projects.length) return void await ctx.reply("Проекты пока не найдены. Используйте /chat.");
    this.projectChoices.set(contextId(ctx), projects);
    const keyboard = new InlineKeyboard();
    projects.slice(0, 30).forEach((project, index) => keyboard.text(`📁 ${this.projectName(project)}`, `project:${index}`).row());
    await ctx.reply("<b>Выберите проект</b>", { parse_mode: "HTML", reply_markup: keyboard });
  }

  private async chooseTaskProject(ctx: Context, taskId: string): Promise<void> {
    if (!this.database.task(taskId)) return void await ctx.answerCallbackQuery({ text: "Задача не найдена" });
    const projects = await this.recentProjects();
    if (!projects.length) return void await ctx.answerCallbackQuery({ text: "Проекты не найдены" });
    this.taskProjectChoices.set(contextId(ctx), { taskId, projects });
    const keyboard = new InlineKeyboard();
    projects.slice(0, 30).forEach((project, index) => keyboard.text(`📁 ${this.projectName(project)}`, `taskproject:${index}`).row());
    await ctx.answerCallbackQuery();
    await ctx.reply("<b>Проект задачи</b>", { parse_mode: "HTML", reply_markup: keyboard });
  }

  private async assignTaskProject(ctx: Context, index: number): Promise<void> {
    const choice = this.taskProjectChoices.get(contextId(ctx));
    const project = choice?.projects[index];
    if (!choice || !project) return void await ctx.answerCallbackQuery({ text: "Список устарел" });
    this.database.updateTask(choice.taskId, { project, projectLabel: this.projectName(project) });
    this.taskProjectChoices.delete(contextId(ctx));
    await ctx.answerCallbackQuery({ text: `Проект: ${this.projectName(project)}` });
  }

  private async recentProjects(): Promise<string[]> {
    const threads = await this.hub.threads(150);
    const result: string[] = [];
    const names = new Set<string>();
    for (const thread of threads) {
      const project = thread.workspace;
      if (!project || generatedWorkspace(project)) continue;
      const key = this.projectName(project).toLocaleLowerCase("ru-RU");
      if (names.has(key)) continue;
      names.add(key);
      result.push(project);
    }
    return result;
  }

  private async showThreads(ctx: Context): Promise<void> {
    const threads = await this.hub.threads(30);
    if (!threads.length) return void await ctx.reply("Треды не найдены.");
    const keyboard = new InlineKeyboard();
    threads.forEach((thread, index) => keyboard.text(`${this.projectName(thread.workspace)} · ${oneLine(thread.title, 28)}`, `thread:${index}`).row());
    await ctx.reply("<b>Последние треды</b>", { parse_mode: "HTML", reply_markup: keyboard });
  }

  private async showSession(ctx: Context): Promise<void> {
    const snapshot = (await this.conversation(ctx)).snapshot();
    await ctx.reply(["<b>Текущая сессия</b>", `Backend: <code>app-server</code>`, `Thread: <code>${escape(snapshot.threadId ?? "не создан")}</code>`,
      `Workspace: <code>${escape(snapshot.workspace)}</code>`, `Profile: <code>${escape(snapshot.profileId)}</code>`, `Running: <b>${snapshot.running ? "да" : "нет"}</b>`].join("\n"), { parse_mode: "HTML" });
  }

  private async renameThread(ctx: Context): Promise<void> {
    const name = commandArgument(ctx);
    if (!name) return void await ctx.reply("Формат: <code>/rename Новое название</code>", { parse_mode: "HTML" });
    const snapshot = (await this.conversation(ctx)).snapshot();
    if (!snapshot.threadId) return void await ctx.reply("Текущий тред ещё не создан.");
    await this.hub.rename(snapshot.threadId, name);
    await ctx.reply(`✅ Тред переименован: <b>${escape(name)}</b>`, { parse_mode: "HTML" });
  }

  private async forkThread(ctx: Context): Promise<void> {
    const conversation = await this.conversation(ctx);
    const snapshot = conversation.snapshot();
    if (!snapshot.threadId) return void await ctx.reply("Текущий тред ещё не создан.");
    const newId = await this.hub.fork(snapshot.threadId);
    await conversation.resume(newId);
    this.persist(ctx, conversation);
    await ctx.reply(`🌿 Создана копия треда\n<code>${escape(newId)}</code>`, { parse_mode: "HTML" });
  }

  private async archiveThread(ctx: Context): Promise<void> {
    const conversation = await this.conversation(ctx);
    const snapshot = conversation.snapshot();
    if (!snapshot.threadId) return void await ctx.reply("Текущий тред ещё не создан.");
    await this.hub.archive(snapshot.threadId);
    conversation.release();
    this.persist(ctx, conversation);
    await ctx.reply("🗄 Тред архивирован. Новый можно создать через /chat или /new.");
  }

  private async health(ctx: Context): Promise<void> {
    const started = Date.now();
    try {
      await this.hub.threads(1);
      await ctx.reply(`✅ Telegram: работает\n✅ Codex app-server: работает\n⏱ ${Date.now() - started} мс`);
    } catch (error) {
      await ctx.reply(`⚠️ Telegram: работает\n❌ Codex app-server: ${errorMessage(error)}`);
    }
  }

  private async taskAction(ctx: Context): Promise<void> {
    const action = ctx.match![1]; const id = ctx.match![2]; const task = this.database.task(id);
    if (!task) { await ctx.answerCallbackQuery({ text: "Задача не найдена" }); return; }
    if (action === "done") {
      this.database.updateTask(id, { status: "done", finishedAt: Date.now() });
      await ctx.answerCallbackQuery({ text: "Готово" }); return;
    }
    if (action === "tomorrow") {
      const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0);
      this.database.updateTask(id, { status: "todo", dueAt: date.getTime() });
      await ctx.answerCallbackQuery({ text: "До завтра" }); return;
    }
    this.database.enqueue(id);
    await ctx.answerCallbackQuery({ text: "Добавлено в очередь" });
  }

  private async captureAction(ctx: Context): Promise<void> {
    const action = ctx.match![1]; const id = ctx.match![2];
    const item = this.database.captures(ownerId(ctx), "new", 500).find((candidate) => candidate.id === id);
    if (!item) { await ctx.answerCallbackQuery({ text: "Не найдено" }); return; }
    if (action === "task") {
      this.database.createTask({ owner: item.owner, title: oneLine(item.body, 140), prompt: item.body });
      this.database.resolveCapture(id, "task");
    } else if (action === "memory") {
      await this.memory.record({ owner: item.owner, body: item.body, role: "user", kind: "explicit", project: this.memoryProject(ctx), source: "telegram-inbox" });
      this.database.resolveCapture(id, "memory");
    } else this.database.resolveCapture(id, "discarded");
    await ctx.answerCallbackQuery({ text: "Готово" });
  }

  private projectName(project: string): string {
    return this.configuration.projectAliases[project] || this.configuration.projectAliases[path.basename(project)] || path.basename(project);
  }

  private memoryProject(ctx: Context): string | undefined {
    return this.database.conversation(contextId(ctx))?.workspace;
  }

  private async rememberIncoming(ctx: Context, body: string, kind: "message" | "action" = "message"): Promise<void> {
    await this.memory.record({ owner: ownerId(ctx), body, role: kind === "action" ? "action" : "user", kind, project: this.memoryProject(ctx), source: "telegram-text" });
  }

  private cancelApprovals(context: string): void {
    for (const [token, waiter] of this.approvals) if (waiter.context === context) {
      clearTimeout(waiter.timer); waiter.settle("cancel"); this.approvals.delete(token);
    }
  }
}

class TextOnlyObserver implements TurnObserver {
  private value = "";
  text(delta: string): void { this.value += delta; }
  toolStarted(): void {}
  toolProgress(): void {}
  toolFinished(): void {}
  approval(): Promise<ApprovalChoice> { return Promise.resolve("decline"); }
  userInput(): Promise<UserInputAnswers> { return Promise.resolve({}); }
  content(): string { return this.value.trim(); }
}

export class TelegramTurnView implements TurnObserver {
  private answer = "";
  private messageId?: number;
  private lastEdit = 0;
  private timer?: NodeJS.Timeout;
  private lastUsage?: string;
  private drain?: Promise<void>;
  private needsFlush = false;
  private finalRequested = false;

  constructor(
    private readonly ctx: Context,
    readonly approval: (prompt: ApprovalPrompt) => Promise<ApprovalChoice>,
    readonly userInput: (prompt: UserInputPrompt) => Promise<UserInputAnswers>,
    private readonly showUsage: boolean,
  ) {}

  text(delta: string): void {
    this.answer += delta;
    this.schedule();
  }
  toolStarted(_id: string, _label: string): void {}
  toolProgress(_id: string, _delta: string): void {}
  toolFinished(_id: string, _failed: boolean): void {}
  plan(_steps: readonly { text: string; done: boolean }[]): void {}
  usage(last: { input: number; cached: number; output: number }): void {
    this.lastUsage = `in ${last.input} · cached ${last.cached} · out ${last.output}`;
  }

  content(): string { return this.answer.trim(); }

  async finish(): Promise<void> {
    this.cancelTimer();
    await this.requestFlush(true);
  }

  async fail(message: string): Promise<void> {
    this.cancelTimer();
    this.answer = this.answer ? `${this.answer}\n\nОшибка: ${message}` : `Ошибка: ${message}`;
    await this.requestFlush(true);
  }

  private schedule(): void {
    if (this.timer) return;
    const delay = Math.max(0, 1000 - (Date.now() - this.lastEdit));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.requestFlush().catch((error) => console.error("Telegram stream update failed", error));
    }, delay);
  }

  private requestFlush(final = false): Promise<void> {
    this.needsFlush = true;
    this.finalRequested ||= final;
    if (!this.drain) {
      this.drain = this.drainFlushes().finally(() => { this.drain = undefined; });
    }
    return this.drain;
  }

  private async drainFlushes(): Promise<void> {
    while (this.needsFlush) {
      this.needsFlush = false;
      const final = this.finalRequested;
      this.finalRequested = false;
      await this.write(final);
    }
  }

  private async write(final: boolean): Promise<void> {
    const source = `${this.answer.trim() || (final ? "Готово" : "…")}${final && this.showUsage && this.lastUsage ? `\n\n${this.lastUsage}` : ""}`;
    const rendered = renderTelegramMarkdown(source, TELEGRAM_LIMIT - 50);
    const { html: text, plain } = rendered;
    if (!this.messageId) {
      const message = await this.ctx.reply(text, { parse_mode: "HTML" }).catch(() => this.ctx.reply(plain));
      this.messageId = message.message_id;
    } else {
      try {
        await this.ctx.api.editMessageText(this.ctx.chat!.id, this.messageId, text, { parse_mode: "HTML" });
      } catch {
        await this.ctx.api.editMessageText(this.ctx.chat!.id, this.messageId, plain).catch(() => undefined);
      }
    }
    this.lastEdit = Date.now();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function persistentKeyboard(): Keyboard {
  return new Keyboard().text("/home").text("/task").row().text("/tasks").text("/inbox").row()
    .text("/chat").text("/new").row().text("/sessions").text("/reminders").row().text("/memory").text("/search").row().text("/abort").resized().persistent();
}
function homeKeyboard(): InlineKeyboard { return new InlineKeyboard().text("➕ Задача", "home:task").text("📋 Задачи", "home:tasks"); }
function taskKeyboard(task: WorkItem): InlineKeyboard { return new InlineKeyboard().text("▶️ В Codex", `task:start:${task.id}`).text("📁 Проект", `task:project:${task.id}`).row().text("✅ Готово", `task:done:${task.id}`).text("⏰ Завтра", `task:tomorrow:${task.id}`); }
function captureKeyboard(id: string): InlineKeyboard { return new InlineKeyboard().text("✅ Задача", `capture:task:${id}`).row().text("📚 В память", `capture:memory:${id}`).text("🗑", `capture:drop:${id}`); }
function taskCard(task: WorkItem): string { return `<b>${taskIcon(task.status)} ${escape(task.title)}</b>\nСтатус: ${escape(task.status)}${task.projectLabel ? `\nПроект: ${escape(task.projectLabel)}` : ""}`; }
function captureCard(item: CapturedItem): string { return `<b>📥 Добавлено в инбокс</b>${item.sender ? `\nОт: ${escape(item.sender)}` : ""}\n\n${escape(oneLine(item.body, 700))}`; }
function voiceModeLabel(settings: VoiceWritingSettings): string {
  if (settings.mode === "diary") return "Дневник";
  if (settings.mode === "story") return `Рассказы · ${settings.storyTitle ?? "без названия"}`;
  return "Обычная расшифровка";
}
function styleWritingLabel(kind: "post" | "announcement" | "reply"): string {
  return ({ post: "Пост", announcement: "Анонс", reply: "Ответ" })[kind];
}
function spokenVoiceHelp(): string {
  return ["<b>🎙 Метки-команды для текста и голоса</b>", "Напишите или произнесите метку первым словом и сразу продолжайте:", "",
    "<b>Пост</b> — оформить публикацию в вашем стиле",
    "<b>Анонс</b> — сделать короткий анонс в вашем стиле",
    "<b>Ответ</b> — подготовить короткий ответ в вашем стиле",
    "<b>Дневник / Заметки</b> — с текстом добавить запись; без текста показать сегодняшний день",
    "<b>Рассказ</b> — продолжить выбранный через /story цикл",
    "<b>Календарь</b> — подготовить событие для подтверждения",
    "<b>Задача</b> — создать задачу",
    "<b>Напоминание</b> — создать напоминание",
    "<b>Идея</b> — положить в инбокс",
    "<b>Запомни</b> — сохранить в долговременную память",
    "",
    "Без метки голосовое просто расшифруется, а обычный текст уйдёт в Codex как прежде."].join("\n");
}
function taskIcon(status: WorkItem["status"]): string { return ({ todo: "⚪", queued: "⏳", running: "▶️", waiting: "❓", done: "✅", cancelled: "🚫" })[status]; }
function approvalCard(prompt: ApprovalPrompt): string { return [`<b>⚠️ Требуется подтверждение: ${escape(prompt.category)}</b>`, prompt.command ? `<code>${escape(prompt.command)}</code>` : "", prompt.directory ? `Папка: <code>${escape(prompt.directory)}</code>` : "", prompt.root ? `Доступ: <code>${escape(prompt.root)}</code>` : "", prompt.reason ? `Причина: ${escape(prompt.reason)}` : ""].filter(Boolean).join("\n\n"); }
function approvalResult(choice: ApprovalChoice): string { return ({ accept: "Разрешено один раз", acceptForSession: "Разрешено на сессию", decline: "Отклонено", cancel: "Ход отменён" })[choice]; }
function contextId(ctx: Context): string { const chat = ctx.chat?.id; if (!chat) throw new Error("Telegram chat is missing"); const topic = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id; return topic ? `${chat}:${topic}` : String(chat); }
function ownerId(ctx: Context): string { if (!ctx.chat) throw new Error("Telegram chat is missing"); return String(ctx.chat.id); }
function escape(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function oneLine(value: string, limit: number): string { const text = value.replace(/\s+/g, " ").trim(); return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`; }
function formatDate(value: number): string { return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Moscow" }).format(new Date(value)); }
function distinct(values: string[]): string[] { return [...new Set(values)]; }
function looksLikeMail(value: string): boolean { const text = value.toLocaleLowerCase("ru-RU"); return /(?:последн|нов|входящ|непрочитанн|найди|покажи|прочитай|ответь).{0,40}(?:письм|почт|gmail)|(?:письм|почт|gmail).{0,40}(?:последн|нов|входящ|непрочитанн|найди|покажи|прочитай|ответь)/i.test(text); }
export type LocalIntent = "reminder" | "calendar-create" | "calendar-list";
export function localIntent(value: string): LocalIntent | null {
  const text = value.toLocaleLowerCase("ru-RU");
  if (/(?:напомни|напоминание|будильник)/i.test(text)) return "reminder";
  if (/(?:создай|добавь|запланируй|поставь).{0,40}(?:в\s+)?календар(?:ь|е)/i.test(text)) return "calendar-create";
  if (/(?:создай|добавь|запланируй|поставь).{0,40}(?:событ|встреч)|(?:событ|встреч).{0,40}(?:создай|добавь|запланируй|поставь)/i.test(text)) return "calendar-create";
  if (/(?:покажи|какие|что|расписание|ближайш).{0,40}(?:календар|событ|встреч)|(?:календар|событ|встреч).{0,40}(?:покажи|какие|что|расписание|ближайш)/i.test(text)) return "calendar-list";
  return null;
}
function gmailPrompt(user: string): string { return `Используй подключённый Gmail как источник почты. Не используй Apple Mail или shell. Чтение и поиск разрешены. Ничего не отправляй, не архивируй, не удаляй и не изменяй без отдельного подтверждения. Не описывай внутренний workflow.\n\n${user}`; }
function searchResults(query: string, hits: ReturnType<AssistantDatabase["search"]>, threads: StoredThread[]): string { const lines = [`<b>🔎 ${escape(query)}</b>`]; for (const hit of hits) lines.push(`${hit.type === "task" ? "📋" : hit.type === "memory" ? "📚" : "📥"} ${escape(oneLine(hit.text, 180))}`); for (const thread of threads) lines.push(`🧵 ${escape(oneLine(thread.title, 180))}`); return lines.length === 1 ? `${lines[0]}\nНичего не найдено.` : lines.join("\n"); }
function recallResults(query: string, hits: RecallHit[]): string {
  if (!hits.length) return `<b>🧠 ${escape(query)}</b>\nНичего релевантного не найдено.`;
  return [`<b>🧠 ${escape(query)}</b>`, ...hits.map((hit) => `\n• ${escape(oneLine(hit.body, 450))}\n<code>${hit.id}</code> · ${hit.namespace === "global" ? "глобальная" : "проектная"}`)].join("\n");
}
function forwardedSource(ctx: Context): ForwardedSourceInfo {
  const origin = ctx.message?.forward_origin;
  if (!origin) return {};
  if (origin.type === "user") return {
    sender: [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(" "),
    time: origin.date * 1000,
    key: `user:${origin.sender_user.id}`,
  };
  if (origin.type === "hidden_user") return {
    sender: origin.sender_user_name,
    time: origin.date * 1000,
    key: `hidden:${origin.sender_user_name.toLocaleLowerCase("ru-RU")}`,
  };
  if (origin.type === "channel") return {
    sender: origin.chat.title,
    time: origin.date * 1000,
    key: `channel:${origin.chat.id}`,
  };
  return {
    sender: origin.sender_chat.title,
    time: origin.date * 1000,
    key: `chat:${origin.sender_chat.id}`,
  };
}
function telegramHtmlOptions(messageThreadId?: number): { parse_mode: "HTML"; message_thread_id?: number } {
  return { parse_mode: "HTML", ...(messageThreadId ? { message_thread_id: messageThreadId } : {}) };
}
function telegramPlainOptions(messageThreadId?: number): { message_thread_id?: number } {
  return messageThreadId ? { message_thread_id: messageThreadId } : {};
}
function commandArgument(ctx: Context): string { return ctx.message?.text?.replace(/^\/\w+(?:@\w+)?\s*/i, "").trim() || ""; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function nextLocalTime(hours: number, minutes: number): number { const date = new Date(); date.setHours(hours, minutes, 0, 0); if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1); return date.getTime(); }
function moscowIso(value: Date): string {
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(value).replace(" ", "T");
  return `${local}+03:00`;
}
function generatedWorkspace(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  const base = path.basename(normalized).toLocaleLowerCase("ru-RU");
  return normalized.includes("/.codex/worktrees/") || normalized.includes("/var/folders/") || normalized.startsWith("/tmp/")
    || /\/Documents\/Codex\/\d{4}-\d{2}-\d{2}\//.test(normalized) || base === "f" || base.startsWith("files-mentioned-by-the-user");
}
function htmlChunks(value: string, limit: number): string[] {
  const result: string[] = [];
  let current = "";
  for (const paragraph of value.split("\n\n")) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) { current = candidate; continue; }
    if (current) result.push(current);
    if (paragraph.length <= limit) { current = paragraph; continue; }
    const plain = paragraph.replaceAll("<b>", "").replaceAll("</b>", "").replaceAll("<i>", "").replaceAll("</i>", "");
    for (let index = 0; index < plain.length; index += limit) result.push(plain.slice(index, index + limit));
    current = "";
  }
  if (current) result.push(current);
  return result;
}

function textChunks(value: string, limit: number): string[] {
  const result: string[] = [];
  let current = "";
  for (const paragraph of value.split("\n\n")) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) { current = candidate; continue; }
    if (current) result.push(current);
    if (paragraph.length <= limit) { current = paragraph; continue; }
    for (let index = 0; index < paragraph.length; index += limit) result.push(paragraph.slice(index, index + limit));
    current = "";
  }
  if (current) result.push(current);
  return result;
}
