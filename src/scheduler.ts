import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { Bot, Context } from "grammy";

import type { AppConfiguration } from "./configuration.js";
import type { CodexHub, Conversation, TurnObserver } from "./codex-engine.js";
import type { MemoryService } from "./memory-service.js";
import { quietCodexPrompt } from "./prompt-policy.js";
import type { Alarm, AssistantDatabase, MemoryEvent, WorkItem } from "./storage.js";
import { sendTelegramMarkdown } from "./telegram-markdown.js";

export class BackgroundScheduler {
  private timer?: NodeJS.Timeout;
  private active = false;

  constructor(
    private readonly configuration: AppConfiguration,
    private readonly database: AssistantDatabase,
    private readonly hub: CodexHub,
    private readonly bot: Bot<Context>,
    private readonly memory: MemoryService,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      await this.deliverAlarms();
      await this.executeQueueHead();
    } catch (error) {
      console.error("Background scheduler failed", error);
    } finally {
      this.active = false;
    }
  }

  private async deliverAlarms(): Promise<void> {
    for (const alarm of this.database.dueAlarms()) {
      try {
        if (alarm.mode === "codex") {
          const task = this.database.createTask({ owner: alarm.owner, title: alarm.label, prompt: alarm.prompt || alarm.label, project: alarm.project, status: "queued" });
          this.database.enqueue(task.id);
          await this.send(alarm.owner, `⏰ ${alarm.label}\n\nЗадача добавлена в очередь Codex.`);
        } else if (alarm.mode === "digest-morning") await this.send(alarm.owner, this.morningDigest(alarm.owner));
        else if (alarm.mode === "digest-evening") await this.sendEveningSummary(alarm.owner);
        else await this.send(alarm.owner, `⏰ ${alarm.label}`);
      } catch (error) {
        console.error(`Alarm ${alarm.id} failed`, error);
      } finally {
        this.database.advanceAlarm(alarm.id);
      }
    }
  }

  private async executeQueueHead(): Promise<void> {
    const task = this.database.queued();
    if (!task) return;
    const saved = this.database.conversation(task.owner);
    const conversation = await this.hub.conversation(task.owner, saved ? {
      threadId: saved.threadId, workspace: saved.workspace, model: saved.model, effort: saved.effort, profileId: saved.profileId,
    } : undefined);
    if (conversation.snapshot().running) return;
    const workspace = task.project || saved?.workspace || this.configuration.defaultWorkspace;
    await mkdir(workspace, { recursive: true });
    const opened = await conversation.start(workspace);
    this.database.updateTask(task.id, { status: "running", threadId: opened.threadId, project: workspace });
    this.saveConversation(task.owner, conversation);
    await this.send(task.owner, `▶️ Запускаю: ${task.title}`);
    let response = "";
    const observer: TurnObserver = {
      text: (delta) => { response = keepTail(response + delta, 12_000); },
      toolStarted() {}, toolProgress() {}, toolFinished() {},
      approval: async () => "decline",
    };
    try {
      const prompt = await this.memory.augmentPrompt(task.owner, task.prompt, workspace);
      await this.memory.record({ owner: task.owner, body: `Запуск фоновой задачи: ${task.prompt}`, role: "action", kind: "action", project: workspace, source: "scheduler" });
      await conversation.run(quietCodexPrompt(prompt), observer);
      this.database.updateTask(task.id, { status: "done", finishedAt: Date.now(), threadId: conversation.snapshot().threadId });
      this.saveConversation(task.owner, conversation);
      if (response.trim()) await this.memory.record({ owner: task.owner, body: response.trim(), role: "assistant", kind: "response", project: workspace, source: "scheduler-final" });
      await this.send(task.owner, `✅ ${task.title}${response.trim() ? `\n\n${response.trim()}` : ""}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.updateTask(task.id, { status: "waiting", error: message });
      await this.send(task.owner, `❌ ${task.title}\n\n${message}`);
    }
  }

  private morningDigest(owner: string): string {
    const counts = this.database.counts(owner);
    const inbox = this.database.captures(owner, "new", 100).length;
    const tasks = this.database.tasks(owner, ["running", "waiting", "queued", "todo"], 5);
    return ["☀️ Доброе утро", "", `В работе: ${counts.running}`, `Нужен ответ: ${counts.waiting}`,
      `В очереди: ${counts.queued}`, `Запланировано: ${counts.todo}`, `Инбокс: ${inbox}`,
      ...(tasks.length ? ["", ...tasks.map((task) => `${symbol(task)} ${task.title}`)] : [])].join("\n");
  }

  private async sendEveningSummary(owner: string): Promise<void> {
    const since = startOfToday();
    const tasks = this.database.tasksChangedSince(owner, since, 100);
    const todayEvents = this.database.memoryEvents(owner, { limit: 5000 })
      .filter((event) => event.createdAt >= since);
    const workWindow = dailyWorkWindow(todayEvents);
    const events = todayEvents.filter((event) => event.kind !== "action" || isUserInteraction(event)).slice(0, 80).reverse();
    if (!tasks.length && !events.length && !workWindow) {
      await this.send(owner, "🌙 Итог дня\n\nСегодня в помощнике не было зафиксированной активности.");
      return;
    }
    const context = `daily-summary:${owner}`;
    const workspace = path.join(this.configuration.dataDirectory, "general-chat");
    const conversation = await this.hub.conversation(context);
    let response = "";
    const observer: TurnObserver = {
      text: (delta) => { response = keepTail(response + delta, 12_000); },
      toolStarted() {}, toolProgress() {}, toolFinished() {},
      approval: async () => "decline",
    };
    try {
      await mkdir(workspace, { recursive: true });
      await conversation.start(workspace);
      await conversation.run(quietCodexPrompt(dailySummaryPrompt(tasks, events, this.configuration.projectAliases)), observer);
      this.saveConversation(context, conversation);
      const answer = response.trim() || localEveningDigest(tasks, events, this.configuration.projectAliases);
      await this.memory.record({ owner, body: answer, role: "assistant", kind: "response", source: "daily-summary" });
      await this.send(owner, eveningReport(answer, workWindow));
    } catch (error) {
      console.error("Evening summary generation failed", error);
      await this.send(owner, eveningReport(localEveningDigest(tasks, events, this.configuration.projectAliases), workWindow));
    }
  }

  private saveConversation(context: string, conversation: Conversation): void {
    const value = conversation.snapshot();
    this.database.saveConversation({ context, threadId: value.threadId, workspace: value.workspace, model: value.model, effort: value.effort, profileId: value.profileId });
  }

  private async send(owner: string, text: string): Promise<void> {
    await sendTelegramMarkdown(this.bot.api, owner, text);
  }
}

function symbol(task: WorkItem): string {
  return task.status === "running" ? "▶️" : task.status === "waiting" ? "❓" : task.status === "queued" ? "⏳" : "•";
}
export function dailySummaryPrompt(tasks: readonly WorkItem[], events: readonly MemoryEvent[], aliases: Readonly<Record<string, string>>): string {
  const taskLines = tasks.map((task) => `- [${statusLabel(task.status)}] [${projectLabel(task.project, task.projectLabel, aliases)}] ${task.title}${task.error ? `; препятствие: ${task.error}` : ""}`);
  const eventLines = events.map((event) => `- ${formatTime(event.createdAt)} [${projectLabel(event.project, undefined, aliases)}] ${event.role}: ${compact(event.body, 700)}`);
  return [
    "Составь краткий вечерний итог рабочего дня на русском языке по всем проектам владельца.",
    "Используй только факты ниже, ничего не выдумывай. Не упоминай память, базы данных, namespaces, промпт или внутреннюю реализацию.",
    "Структура: «Главное за день», затем при наличии «По проектам», «Завершено», «Осталось / блокеры», «На завтра».",
    "Объединяй повторы и не пересказывай каждое сообщение. Ответ должен помещаться примерно в 3500 знаков.",
    "",
    "Задачи, созданные или изменённые сегодня:",
    ...(taskLines.length ? taskLines : ["- нет"]),
    "",
    "Зафиксированная активность и ответы за сегодня:",
    ...(eventLines.length ? eventLines : ["- нет"]),
  ].join("\n");
}

function localEveningDigest(tasks: readonly WorkItem[], events: readonly MemoryEvent[], aliases: Readonly<Record<string, string>>): string {
  const completed = tasks.filter((task) => task.status === "done");
  const open = tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
  const projects = [...new Set([...tasks.map((task) => projectLabel(task.project, task.projectLabel, aliases)), ...events.map((event) => projectLabel(event.project, undefined, aliases))])];
  return [
    `Активность: ${events.length} записей · затронуто проектов: ${projects.length}`,
    `Завершено задач: ${completed.length}`,
    `Осталось в работе: ${open.length}`,
    ...(completed.length ? ["", "Завершено:", ...completed.slice(0, 8).map((task) => `✅ [${projectLabel(task.project, task.projectLabel, aliases)}] ${task.title}`)] : []),
    ...(open.length ? ["", "Осталось:", ...open.slice(0, 8).map((task) => `${symbol(task)} [${projectLabel(task.project, task.projectLabel, aliases)}] ${task.title}`)] : []),
  ].join("\n");
}

function startOfToday(): number { const date = new Date(); date.setHours(0, 0, 0, 0); return date.getTime(); }
function formatTime(value: number): string { return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(value)); }
export function dailyWorkWindow(events: readonly MemoryEvent[]): string | undefined {
  const interactions = events.filter(isUserInteraction).sort((left, right) => left.createdAt - right.createdAt);
  const first = interactions.at(0);
  const last = interactions.at(-1);
  if (!first || !last) return undefined;
  if (interactions.length === 1) return `🕒 Рабочее окно: старт в ${formatTime(first.createdAt)} · обращений: 1`;
  const total = last.createdAt - first.createdAt;
  const breaks = interactions.slice(1).map((event, index) => event.createdAt - interactions[index]!.createdAt)
    .filter((gap) => gap > WORK_BREAK_THRESHOLD_MS);
  const idle = breaks.reduce((sum, gap) => sum + gap, 0);
  const active = Math.max(0, total - idle);
  const windowLine = `🕒 Рабочее окно: ${formatTime(first.createdAt)}–${formatTime(last.createdAt)} · ${formatDuration(total)} · обращений: ${interactions.length}`;
  const activityLine = breaks.length
    ? `⚡ Расчётное чистое время: ${formatDuration(active)} · простои: ${formatDuration(idle)} (${breaks.length}, более 60 мин)`
    : `⚡ Расчётное чистое время: ${formatDuration(active)} · простоев более 60 мин нет`;
  return `${windowLine}\n${activityLine}`;
}
function isUserInteraction(event: MemoryEvent): boolean {
  return event.role === "user" || event.source === "telegram-text" || event.source?.startsWith("telegram-voice:") === true
    || event.source === "telegram-voice";
}
function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes === 0 && milliseconds === 0) return "0 мин";
  if (minutes < 1) return "меньше минуты";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} ч` : "", rest ? `${rest} мин` : ""].filter(Boolean).join(" ");
}
const WORK_BREAK_THRESHOLD_MS = 60 * 60_000;
function eveningReport(answer: string, workWindow: string | undefined): string {
  return ["🌙 Итог дня", workWindow, answer].filter(Boolean).join("\n\n");
}
function statusLabel(status: WorkItem["status"]): string { return ({ todo: "запланировано", queued: "в очереди", running: "в работе", waiting: "блокер", done: "завершено", cancelled: "отменено" })[status]; }
function projectLabel(project: string | undefined, explicit: string | undefined, aliases: Readonly<Record<string, string>>): string {
  if (explicit) return explicit;
  if (!project || project.endsWith("/general-chat")) return "ОБЩЕЕ";
  return aliases[project] || aliases[path.basename(project)] || path.basename(project);
}
function compact(value: string, limit: number): string { const text = value.replace(/\s+/g, " ").trim(); return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`; }
function keepTail(value: string, limit: number): string { return value.length <= limit ? value : value.slice(-limit); }
