import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";

import type { AppConfiguration } from "./configuration.js";
import { structureTranscript, transcribeAudio } from "./audio.js";
import { CodexHub, type ApprovalChoice, type ApprovalPrompt, type Conversation, type StoredThread, type TurnObserver } from "./codex-engine.js";
import { activateCodexWithResume, addCalendarEvent, makeMailDraft, upcomingCalendar } from "./mac-bridge.js";
import { understandAlarm } from "./reminder-language.js";
import { AssistantDatabase, type CapturedItem, type WorkItem } from "./storage.js";

const TELEGRAM_LIMIT = 4000;

type PendingInput = "task" | "capture" | "memory" | "search" | "reminder";

interface ApprovalWaiter {
  context: string;
  settle: (choice: ApprovalChoice) => void;
  timer: NodeJS.Timeout;
}

interface PendingCalendarEvent { title: string; start: number; }

export class TelegramApplication {
  readonly bot: Bot<Context>;
  private readonly pending = new Map<string, PendingInput>();
  private readonly approvals = new Map<string, ApprovalWaiter>();
  private readonly projectChoices = new Map<string, string[]>();
  private readonly taskProjectChoices = new Map<string, { taskId: string; projects: string[] }>();
  private readonly calendarEvents = new Map<string, PendingCalendarEvent>();

  constructor(
    private readonly configuration: AppConfiguration,
    private readonly hub: CodexHub,
    private readonly database: AssistantDatabase,
  ) {
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
    this.bot.stop();
  }

  private install(): void {
    this.bot.use(async (ctx, next) => {
      if (!ctx.from || !this.configuration.allowedUsers.has(ctx.from.id)) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Нет доступа" }).catch(() => undefined);
        else if (ctx.chat) await ctx.reply("Нет доступа").catch(() => undefined);
        return;
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
        "<b>Ассистент</b>", "/remind · /reminders · /remember · /memory · /search", "",
        "<b>Mac</b>", "/calendar · /event · /draft · /mac", "",
        "<b>Автоматизация</b>", "/schedule · /digest", "",
        "Голосовые расшифровываются отдельно и не запускают Codex.",
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
      await ctx.answerCallbackQuery({ text: this.database.forget(ctx.match![1]) ? "Удалено" : "Не найдено" });
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
      const sentAt = forwarded.time || (ctx.message?.date ? ctx.message.date * 1000 : undefined);
      await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
      for (const part of htmlChunks(structureTranscript(raw, { sender, sentAt }), TELEGRAM_LIMIT)) {
        await ctx.reply(part, { parse_mode: "HTML" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, `Не удалось расшифровать: ${message}`).catch(() => undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async attachmentMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message) return;
    const source = forwardedSource(ctx);
    const name = message.document?.file_name || message.video?.file_name || (message.photo ? "Фотография" : "Файл");
    const body = [name, message.caption].filter(Boolean).join("\n");
    const captured = this.database.capture({ owner: ownerId(ctx), kind: message.photo ? "photo" : message.video ? "video" : "document", body, sender: source.sender, sourceTime: source.time });
    await ctx.reply(`${captureCard(captured)}\n\n<i>Codex-тред не запускался.</i>`, { parse_mode: "HTML", reply_markup: captureKeyboard(captured.id) });
  }

  private async textMessage(ctx: Context): Promise<void> {
    const text = ctx.message?.text?.trim();
    if (!text || text.startsWith("/")) return;
    const key = contextId(ctx);
    const pending = this.pending.get(key);
    if (pending) {
      this.pending.delete(key);
      await this.acceptPending(ctx, pending, text);
      return;
    }
    if (ctx.message?.forward_origin) {
      const source = forwardedSource(ctx);
      const captured = this.database.capture({ owner: ownerId(ctx), kind: "forward", body: text, sender: source.sender, sourceTime: source.time });
      await ctx.reply(captureCard(captured), { parse_mode: "HTML", reply_markup: captureKeyboard(captured.id) });
      return;
    }
    const conversation = await this.conversation(ctx);
    const routed = looksLikeMail(text) ? gmailPrompt(text) : text;
    if (conversation.snapshot().running) {
      await conversation.steer(routed);
      await ctx.reply("↪️ Уточнение добавлено в текущий ход.");
      return;
    }
    await this.executePrompt(ctx, routed);
  }

  private async executePrompt(ctx: Context, prompt: string): Promise<void> {
    const conversation = await this.conversation(ctx);
    const view = new TelegramTurnView(ctx, (request) => this.askApproval(ctx, request), this.configuration.showUsage);
    try {
      await conversation.run(prompt, view);
      await view.finish();
      this.persist(ctx, conversation);
    } catch (error) {
      await view.fail(error instanceof Error ? error.message : String(error));
    }
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
      ...(alarms.length ? ["", "<b>Напоминания</b>", ...alarms.map((alarm) => `⏰ ${escape(alarm.label)} · ${formatDate(alarm.nextAt)}`)] : [])].join("\n");
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: homeKeyboard() });
  }

  private async captureCommand(ctx: Context, kind: PendingInput): Promise<void> {
    const command = ctx.message?.text?.replace(/^\/\w+(?:@\w+)?\s*/i, "").trim() || "";
    if (command) return this.acceptPending(ctx, kind, command);
    this.pending.set(contextId(ctx), kind);
    const prompts: Record<PendingInput, string> = { task: "Напишите новую задачу.", capture: "Что добавить в инбокс?", memory: "Что запомнить?", search: "Что найти?", reminder: "Когда и о чём напомнить?" };
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
      this.database.remember(owner, value); await ctx.reply("📚 Сохранено в память.");
    } else if (kind === "search") {
      const hits = this.database.search(owner, value, 20);
      const threads = await this.hub.threads(10, value).catch(() => []);
      await ctx.reply(searchResults(value, hits, threads), { parse_mode: "HTML" });
    } else {
      const parsed = understandAlarm(value);
      if (!parsed) return void await ctx.reply("Не понял время. Например: завтра в 10 позвонить Анне.");
      const alarm = this.database.createAlarm({ owner, label: parsed.label, nextAt: parsed.at, cadence: parsed.cadence });
      await ctx.reply(`⏰ <b>${escape(alarm.label)}</b>\n${formatDate(alarm.nextAt)}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Удалить", `alarm:delete:${alarm.id}`) });
    }
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
    const memories = this.database.memories(ownerId(ctx));
    if (!memories.length) return void await ctx.reply("Память пуста.");
    for (const note of memories) await ctx.reply(`📚 ${escape(oneLine(note.body, 600))}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Удалить", `memory:delete:${note.id}`) });
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
    const parsed = understandAlarm(input);
    if (!parsed) return void await ctx.reply("Не понял дату и время события.");
    const token = randomUUID().slice(0, 10);
    this.calendarEvents.set(token, { title: parsed.label, start: parsed.at });
    const keyboard = new InlineKeyboard().text("✅ Создать", `event:confirm:${token}`).text("Отмена", `event:cancel:${token}`);
    await ctx.reply(`Создать событие?\n<b>${escape(parsed.label)}</b>\n${formatDate(parsed.at)}`, { parse_mode: "HTML", reply_markup: keyboard });
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
    const evening = nextLocalTime(20, 0);
    this.database.createAlarm({ owner, label: "Утренний дайджест", nextAt: morning, cadence: "daily", mode: "digest-morning" });
    this.database.createAlarm({ owner, label: "Вечерний дайджест", nextAt: evening, cadence: "daily", mode: "digest-evening" });
    await ctx.reply("✅ Дайджесты включены: ежедневно в 09:00 и 20:00.");
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
      this.database.remember(item.owner, item.body, "inbox"); this.database.resolveCapture(id, "memory");
    } else this.database.resolveCapture(id, "discarded");
    await ctx.answerCallbackQuery({ text: "Готово" });
  }

  private projectName(project: string): string {
    return this.configuration.projectAliases[project] || this.configuration.projectAliases[path.basename(project)] || path.basename(project);
  }

  private cancelApprovals(context: string): void {
    for (const [token, waiter] of this.approvals) if (waiter.context === context) {
      clearTimeout(waiter.timer); waiter.settle("cancel"); this.approvals.delete(token);
    }
  }
}

class TelegramTurnView implements TurnObserver {
  private answer = "";
  private messageId?: number;
  private lastEdit = 0;
  private timer?: NodeJS.Timeout;
  private lastUsage?: string;

  constructor(
    private readonly ctx: Context,
    readonly approval: (prompt: ApprovalPrompt) => Promise<ApprovalChoice>,
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

  async finish(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.flush(true);
  }

  async fail(message: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.answer = this.answer ? `${this.answer}\n\nОшибка: ${message}` : `Ошибка: ${message}`;
    await this.flush(true);
  }

  private schedule(): void {
    if (this.timer) return;
    const delay = Math.max(0, 1000 - (Date.now() - this.lastEdit));
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, delay);
  }

  private async flush(final = false): Promise<void> {
    const source = `${this.answer.trim() || (final ? "Готово" : "…")}${final && this.showUsage && this.lastUsage ? `\n\n${this.lastUsage}` : ""}`;
    const text = source.slice(0, TELEGRAM_LIMIT - 50);
    if (!this.messageId) {
      const message = await this.ctx.reply(text);
      this.messageId = message.message_id;
    } else {
      await this.ctx.api.editMessageText(this.ctx.chat!.id, this.messageId, text).catch(() => undefined);
    }
    this.lastEdit = Date.now();
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
function gmailPrompt(user: string): string { return `Используй подключённый Gmail как источник почты. Не используй Apple Mail или shell. Чтение и поиск разрешены. Ничего не отправляй, не архивируй, не удаляй и не изменяй без отдельного подтверждения. Не описывай внутренний workflow.\n\n${user}`; }
function searchResults(query: string, hits: ReturnType<AssistantDatabase["search"]>, threads: StoredThread[]): string { const lines = [`<b>🔎 ${escape(query)}</b>`]; for (const hit of hits) lines.push(`${hit.type === "task" ? "📋" : hit.type === "memory" ? "📚" : "📥"} ${escape(oneLine(hit.text, 180))}`); for (const thread of threads) lines.push(`🧵 ${escape(oneLine(thread.title, 180))}`); return lines.length === 1 ? `${lines[0]}\nНичего не найдено.` : lines.join("\n"); }
function forwardedSource(ctx: Context): { sender?: string; time?: number } { const origin = ctx.message?.forward_origin; if (!origin) return {}; if (origin.type === "user") return { sender: [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(" "), time: origin.date * 1000 }; if (origin.type === "hidden_user") return { sender: origin.sender_user_name, time: origin.date * 1000 }; if (origin.type === "channel") return { sender: origin.chat.title, time: origin.date * 1000 }; return { time: origin.date * 1000 }; }
function commandArgument(ctx: Context): string { return ctx.message?.text?.replace(/^\/\w+(?:@\w+)?\s*/i, "").trim() || ""; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function nextLocalTime(hours: number, minutes: number): number { const date = new Date(); date.setHours(hours, minutes, 0, 0); if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1); return date.getTime(); }
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
