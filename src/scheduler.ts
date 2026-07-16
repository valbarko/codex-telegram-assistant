import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Bot, Context } from "grammy";

import type { AppConfiguration } from "./configuration.js";
import type { CodexHub, Conversation, StoredThread, TurnObserver } from "./codex-engine.js";
import { todayCalendar, type CalendarEntry } from "./mac-bridge.js";
import type { MemoryService } from "./memory-service.js";
import { quietCodexPrompt } from "./prompt-policy.js";
import { logInternalError, publicErrorMessage } from "./public-errors.js";
import type { Alarm, AssistantDatabase, MemoryEvent, WorkItem } from "./storage.js";
import { sendTelegramMarkdown } from "./telegram-markdown.js";
import { countActiveWork, groupActiveWork, internalAssistantWorkspace, internalWorkThread, mergeActiveWork, type UnifiedWorkGroup } from "./work-dashboard.js";
import { todayWeather } from "./weather.js";

export interface WorkJournalEntry {
  project: string;
  time: string;
  request: string;
  result: string;
}

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
        } else if (alarm.mode === "digest-morning") await this.send(alarm.owner, await this.morningDigest(alarm.owner));
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
    const opened = await conversation.start(workspace, task.title);
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
      logInternalError(`Scheduled task ${task.id} failed`, error);
      const message = publicErrorMessage("scheduled-task");
      this.database.updateTask(task.id, { status: "waiting", error: message });
      await this.send(task.owner, `❌ ${task.title}\n\n${message}`);
    }
  }

  private async morningDigest(owner: string): Promise<string> {
    const inbox = this.database.captures(owner, "new", 100).length;
    const tasks = this.database.tasks(owner, undefined, 500);
    const summaryThread = this.database.conversation(`daily-summary:${owner}`)?.threadId;
    const [weather, calendar, threads] = await Promise.allSettled([
      todayWeather({
        label: this.configuration.weatherLocation,
        latitude: this.configuration.weatherLatitude,
        longitude: this.configuration.weatherLongitude,
      }),
      within(todayCalendar(20), 10_000, "calendar"),
      within(this.hub.threads(150), 7_000, "Codex threads"),
    ]);
    if (weather.status === "rejected") console.error("Morning weather failed", weather.reason);
    if (calendar.status === "rejected") console.error("Morning calendar failed", calendar.reason);
    if (threads.status === "rejected") console.error("Morning project loading failed", threads.reason);
    const excluded = new Set(summaryThread ? [summaryThread] : []);
    const visibleThreads = threads.status === "fulfilled" ? recentProjectThreads(threads.value.filter((thread) =>
      !generatedWorkspace(thread.workspace) && !internalAssistantWorkspace(thread.workspace, this.configuration.dataDirectory)
      && !internalWorkThread(thread))) : [];
    const groups = groupActiveWork(mergeActiveWork(tasks, visibleThreads, this.configuration.projectAliases, excluded));
    return morningDigestText({
      weather: weather.status === "fulfilled" ? weather.value : `🌦 Погода · ${this.configuration.weatherLocation}\nНе удалось получить прогноз.`,
      calendar: calendar.status === "fulfilled" ? calendar.value : undefined,
      groups,
      inbox,
      tasks,
    });
  }

  private async sendEveningSummary(owner: string): Promise<void> {
    const { since, until } = previousDayWindow();
    const tasks = this.database.tasksChangedBetween(owner, since, until, 100);
    const todayEvents = this.database.memoryEvents(owner, { limit: 5000 })
      .filter((event) => event.createdAt >= since && event.createdAt < until);
    const events = todayEvents.filter(isReportableEvent).reverse();
    const journal = await loadWorkJournal(this.configuration.defaultWorkspace, since);
    if (!tasks.length && !events.length && !journal.length) {
      await this.send(owner, "🌅 Итог за вчера\n\nЗа вчера не зафиксировано рабочей активности, пригодной для отчёта.");
      return;
    }
    const dryDigest = localDailyDigest(tasks, events, this.configuration.projectAliases, journal);
    const completionEvidence = dailyCompletionEvidence(tasks, journal, this.configuration.projectAliases);
    const digest = await this.polishDailyDigest(owner, dryDigest, completionEvidence);
    await this.send(owner, dailyReport(digest, since));
  }

  private async polishDailyDigest(owner: string, dryDigest: string, completionEvidence: string): Promise<string> {
    const context = `daily-summary:${owner}`;
    const workspace = path.join(this.configuration.dataDirectory, "general-chat");
    const saved = this.database.conversation(context);
    let conversation: Conversation | undefined;
    let response = "";
    const observer: TurnObserver = {
      text: (delta) => { response = keepTail(response + delta, 8_000); },
      toolStarted() {}, toolProgress() {}, toolFinished() {},
      approval: async () => "decline",
    };
    try {
      await mkdir(workspace, { recursive: true });
      const generation = (async () => {
        conversation = await this.hub.conversation(context, saved ? {
          threadId: saved.threadId, workspace: saved.workspace, model: saved.model, effort: saved.effort, profileId: saved.profileId,
        } : undefined);
        if (!conversation.snapshot().threadId) await conversation.start(workspace, "Ежедневные сводки");
        await conversation.run(quietCodexPrompt(dailyDigestPolishPrompt(dryDigest, completionEvidence)), observer);
      })();
      await within(generation, 35_000, "daily digest AI");
      const polished = validatedPolishedDigest(response, dryDigest);
      if (!conversation) throw new Error("Daily digest conversation was not created");
      this.saveConversation(context, conversation);
      await this.memory.record({ owner, body: polished, role: "assistant", kind: "response", source: "daily-summary" });
      return polished;
    } catch (error) {
      console.error("Daily digest AI formatting failed; using deterministic digest", error);
      if (conversation?.snapshot().running) void conversation.interrupt().catch(() => undefined);
      this.hub.remove(context);
      return dryDigest;
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
  return statusSymbol(task.status);
}

export interface MorningDigestInput {
  weather: string;
  calendar?: readonly CalendarEntry[];
  groups: readonly UnifiedWorkGroup[];
  inbox: number;
  tasks: readonly WorkItem[];
  now?: number;
}

export function morningDigestText(input: MorningDigestInput): string {
  const items = input.groups.flatMap((group) => group.items);
  const counts = countActiveWork(items);
  const now = input.now ?? Date.now();
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const activeTasks = input.tasks.filter((task) => !["done", "cancelled"].includes(task.status));
  const tasksById = new Map(activeTasks.map((task) => [task.id, task]));
  const attention = items.flatMap((item) => {
    const task = tasksById.get(item.id);
    if (task?.dueAt !== undefined && task.dueAt < dayStart.getTime()) {
      return [{ item, dueAt: task.dueAt, reason: "Просрочено", icon: "🔴", rank: 0 }];
    }
    if (task?.dueAt !== undefined && task.dueAt < dayEnd.getTime()) {
      return [{ item, dueAt: task.dueAt, reason: "Сегодня", icon: "📅", rank: 1 }];
    }
    if (item.status === "waiting") return [{ item, dueAt: Number.MAX_SAFE_INTEGER, reason: "Нужен ответ", icon: "❓", rank: 2 }];
    return [];
  }).sort((left, right) => left.rank - right.rank || left.dueAt - right.dueAt || right.item.updatedAt - left.item.updatedAt);
  const projectLines = input.groups.map((group) => {
    const topics = group.items.slice(0, 3).map((item) => morningTopic(item.title));
    const more = group.items.length > 3 ? `; ещё ${group.items.length - 3}` : "";
    return `- **${group.label} · ${group.items.length}** — ${topics.join("; ")}${more}.`;
  });
  const attentionLines = attention.slice(0, 3).map(({ item, reason, icon }) =>
    `- ${icon} **${reason} · ${item.projectLabel}** — ${digestText(item.title, 110)}`);
  if (attention.length > 3) attentionLines.push(`- Ещё требуют внимания: **${attention.length - 3}**`);
  const calendarLines = input.calendar === undefined
    ? ["**🗓 Сегодня · Apple Calendar**", "", "Не удалось прочитать системный календарь."]
    : input.calendar.length
      ? ["**🗓 Сегодня · Apple Calendar**", "", ...input.calendar.map((entry) => `- **${digestText(entry.start, 70)}** · ${digestText(entry.title, 100)}`)]
      : ["**🗓 Сегодня · Apple Calendar**", "", "Событий на сегодня нет."];
  return [
    "☀️ **Доброе утро**",
    "",
    formatWeatherBlock(input.weather),
    "",
    ...calendarLines,
    "",
    "**Главное**",
    "",
    `Активно: **${countLabel(items.length, "тема", "темы", "тем")}** в **${countLabel(input.groups.length, "проекте", "проектах", "проектах")}**`,
    `Требуют внимания: **${attention.length}** · очередь: **${counts.queued}** · инбокс: **${input.inbox}**`,
    "",
    "**Самое важное**",
    "",
    ...(attentionLines.length ? attentionLines : ["Срочных задач и ожидающих ответа **нет**."]),
    "",
    "**Проекты**",
    "",
    ...(projectLines.length ? projectLines : ["Активных тем по проектам нет."]),
  ].join("\n");
}

export function recentProjectThreads(threads: readonly StoredThread[], now = Date.now(), perProject = 3): StoredThread[] {
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 1);
  const counts = new Map<string, number>();
  return [...threads].sort((left, right) => right.updatedAt - left.updatedAt).filter((thread) => {
    if (thread.updatedAt < since.getTime()) return false;
    const project = path.normalize(thread.workspace || "<none>").replace(/[\\/]+$/, "").toLocaleLowerCase("ru-RU");
    const count = counts.get(project) ?? 0;
    if (count >= perProject) return false;
    counts.set(project, count + 1);
    return true;
  });
}

export function dailySummaryPrompt(tasks: readonly WorkItem[], events: readonly MemoryEvent[], aliases: Readonly<Record<string, string>>,
  journal: readonly WorkJournalEntry[] = []): string {
  const taskLines = tasks.map((task) => `- [${statusLabel(task.status)}] [${projectLabel(task.project, task.projectLabel, aliases)}] ${task.title}${task.error ? `; препятствие: ${task.error}` : ""}`);
  const eventLines = events.map((event) => `- ${formatTime(event.createdAt)} [${projectLabel(event.project, undefined, aliases)}] ${event.role}: ${compact(event.body, 700)}`);
  const journalLines = journal.map((entry) => `- ${entry.time} [${projectLabel(entry.project, undefined, aliases)}] запрос: ${compact(entry.request, 280)}; результат: ${compact(entry.result, 900)}`);
  return [
    "Составь краткий утренний отчёт на русском языке о работе владельца за предыдущий календарный день по всем проектам.",
    "Используй только факты ниже, ничего не выдумывай. Не упоминай память, базы данных, namespaces, промпт или внутреннюю реализацию.",
    "Покажи: «Главное», «Над чем работали», «Что сделали», «Что закрыли», «Что осталось / блокеры». Пустые разделы пропускай.",
    "Различай обсуждение, выполненную работу и полностью закрытые задачи. Следующие шаги указывай только если они были явно поставлены или следуют из незавершённой задачи.",
    "Не превращай содержание расшифровываемых, переводимых, редактируемых, пересказываемых или анализируемых материалов в факты о владельце, его проектах, решениях и планах. Само содержание таких материалов не включай в отчёт.",
    "Не оценивай рабочее время по времени сообщений. Объединяй повторы и не пересказывай каждое сообщение. Ответ должен помещаться примерно в 3500 знаков.",
    "",
    "Задачи, созданные или изменённые сегодня:",
    ...(taskLines.length ? taskLines : ["- нет"]),
    "",
    "Зафиксированная рабочая активность и результаты за день:",
    ...(eventLines.length ? eventLines : ["- нет"]),
    "",
    "Журнал завершённых и продолжающихся задач Codex по рабочим проектам:",
    ...(journalLines.length ? journalLines : ["- нет"]),
  ].join("\n");
}

export function dailyDigestPolishPrompt(dryDigest: string, completionEvidence = ""): string {
  return [
    "Отредактируй сухую ежедневную сводку на русском языке и верни только готовый текст без комментариев и без заголовка «Итог за вчера».",
    "Сохрани все проверенные факты, цифры, времена, проекты, перерывы и подпись о приблизительности расчёта из сухой сводки.",
    "По подтверждениям ниже сформируй честный раздел **Что завершили**: объедини повторы и подзадачи одного результата, оставь 2–6 наиболее существенных завершений на проект. Не называй точное число закрытых задач, если его нельзя доказать.",
    "Сухой раздел завершений — только резервный черновик. Если доказательства содержат три и более независимых завершения проекта, обязательно покажи хотя бы три; для самого активного проекта предпочти 4–6 крупных итогов.",
    "Не включай обсуждения, рекомендации, ревью без внесённых правок и незавершённую локальную работу. Не повторяй одни и те же результаты в нескольких разделах.",
    "Сделай короткое саммари, выдели важные слова и цифры через **жирный**, раздели смысловые блоки пустыми строками.",
    "Не добавляй SHA, PR, GitHub-ссылки, URL, локальные пути, технические логи, таблицы и сведения о внутренней реализации.",
    "Используй только простой Telegram Markdown: **жирный**, *курсив*, маркированные списки. Уложись примерно в 1800 знаков.",
    "",
    "Сухая сводка:",
    dryDigest,
    ...(completionEvidence ? ["", "Кандидаты с подтверждённым результатом — используй как доказательства, а не как готовый список:", completionEvidence] : []),
  ].join("\n");
}

export function dailyCompletionEvidence(tasks: readonly WorkItem[], journal: readonly WorkJournalEntry[],
  aliases: Readonly<Record<string, string>>, perProject = 12): string {
  const lines: string[] = [];
  const projects = [...new Set(journal.map((entry) => projectLabel(entry.project, undefined, aliases)))];
  for (const project of projects) {
    const candidates = completionEntries(journal.filter((entry) => projectLabel(entry.project, undefined, aliases) === project), perProject);
    if (!candidates.length) continue;
    lines.push(`ПРОЕКТ ${project}`);
    for (const entry of candidates) {
      const request = digestText(entry.request, 150) || "контекстное продолжение задачи";
      lines.push(`- запрос: ${request}; подтверждённый результат: ${digestText(entry.result, 240)}`);
    }
  }
  for (const task of tasks.filter((item) => item.status === "done")) {
    lines.push(`- [${projectLabel(task.project, task.projectLabel, aliases)}] отдельная задача бота со статусом done: ${digestText(task.title, 150)}`);
  }
  return lines.join("\n");
}

export function localDailyDigest(tasks: readonly WorkItem[], events: readonly MemoryEvent[], aliases: Readonly<Record<string, string>>,
  journal: readonly WorkJournalEntry[]): string {
  const completed = tasks.filter((task) => task.status === "done");
  const open = tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
  const projects = [...new Set([...tasks.map((task) => projectLabel(task.project, task.projectLabel, aliases)),
    ...events.map((event) => projectLabel(event.project, undefined, aliases)),
    ...journal.map((entry) => projectLabel(entry.project, undefined, aliases))])];
  const projectSections = projects.map((project) => {
    const entries = journal.filter((entry) => projectLabel(entry.project, undefined, aliases) === project);
    const eventCount = events.filter((event) => projectLabel(event.project, undefined, aliases) === project).length;
    if (!entries.length) return `**${project}** · **${countLabel(eventCount, "запись активности", "записи активности", "записей активности")}**`;
    const times = entries.map((entry) => entry.time).sort(compareTimes);
    const interval = times.length > 1 ? `${times[0]}–${times.at(-1)}` : times[0];
    const topics = representativeEntries(entries).map(journalTopic).filter(Boolean);
    return [
      `**${project}** · **${countLabel(entries.length, "обращение", "обращения", "обращений")}** · ${interval}`,
      topics.length ? sentence(topics.join("; ")) : "Рабочая активность без отдельного результата.",
    ].join("\n");
  });
  const completionLines = localCompletionLines(completed, journal, aliases);
  return [
    "**Главное**",
    "",
    `- Проектов с активностью: **${projects.length}**`,
    `- Проектов с подтверждёнными завершениями: **${completionLines.length}**`,
    "",
    dailyActivitySummary(events, journal, aliases),
    ...(projects.length ? ["", "**По проектам**", "", ...projectSections.flatMap((section) => [section, ""]).slice(0, -1)] : []),
    ...(completionLines.length ? ["", "**Что завершили**", "", ...completionLines] : []),
    ...(open.length ? ["", "**Осталось в задачах бота / блокеры**", "", ...open.map((task) =>
      `${symbol(task)} **${projectLabel(task.project, task.projectLabel, aliases)}:** ${digestText(task.title, 130)}`)] : []),
  ].join("\n");
}

export function dailyActivitySummary(events: readonly MemoryEvent[], journal: readonly WorkJournalEntry[],
  aliases: Readonly<Record<string, string>>): string {
  const points = journal.map((entry) => ({ time: entry.time, project: projectLabel(entry.project, undefined, aliases) }));
  const journalProjects = new Set(points.map((point) => point.project));
  for (const event of events.filter(isUserInteraction)) {
    const point = { time: formatTime(event.createdAt), project: projectLabel(event.project, undefined, aliases) };
    if (!journalProjects.has(point.project)) points.push(point);
  }
  points.sort((left, right) => compareTimes(left.time, right.time));
  const first = points.at(0)?.time;
  const last = points.at(-1)?.time;
  if (!first || !last) return "**Рабочая активность**\n\nОбращений не зафиксировано.";
  if (points.length === 1) return [
    "**Рабочая активность**",
    "",
    `**${first}** · зафиксировано **1 обращение**`,
  ].join("\n");
  const span = Math.max(0, timeToMinutes(last) - timeToMinutes(first));
  const uniqueTimes = [...new Set(points.map((point) => point.time))].sort(compareTimes);
  const breaks = uniqueTimes.slice(1).flatMap((time, index) => {
    const previous = uniqueTimes[index]!;
    const duration = timeToMinutes(time) - timeToMinutes(previous);
    return duration > 60 ? [{ from: previous, to: time, duration }] : [];
  });
  const breakMinutes = breaks.reduce((total, item) => total + item.duration, 0);
  const activityEstimate = Math.max(0, span - breakMinutes);
  const estimateLines = uniqueTimes.length >= 10 ? [
    `Оценочно активно: **${formatMinutes(activityEstimate)}**`,
    ...(breaks.length ? [
      `Перерывы дольше часа: **${breaks.length}** · всего **${formatMinutes(breakMinutes)}**`,
      ...breaks.slice(0, 4).map((item) => `- **${item.from}–${item.to}** · ${formatMinutes(item.duration)}`),
      ...(breaks.length > 4 ? [`- Ещё перерывов: **${breaks.length - 4}**`] : []),
    ] : ["Перерывов дольше часа не зафиксировано."]),
  ] : ["Для оценки активного времени недостаточно обращений."];
  return [
    "**Рабочая активность**",
    "",
    `**${first}–${last}** · период **${formatMinutes(span)}**`,
    ...estimateLines,
    `Зафиксировано **${countLabel(points.length, "обращение", "обращения", "обращений")}**`,
    "",
    "*Оценка: перерывы без обращений дольше 60 минут вычтены; короткие паузы считаются рабочими.*",
  ].join("\n");
}

function formatTime(value: number): string { return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(value)); }
export function previousDayWindow(now = Date.now()): { since: number; until: number } {
  const until = new Date(now);
  until.setHours(0, 0, 0, 0);
  const since = new Date(until);
  since.setDate(since.getDate() - 1);
  return { since: since.getTime(), until: until.getTime() };
}
export function parseWorkJournal(content: string, project: string): WorkJournalEntry[] {
  return content.split(/(?=^### \d{2}:\d{2}\s*$)/m).flatMap((section) => {
    const time = section.match(/^### (\d{2}:\d{2})\s*$/m)?.[1];
    const requestStart = section.indexOf("- User asked:");
    const resultStart = section.indexOf("- Codex:");
    if (!time || requestStart < 0 || resultStart < 0 || resultStart <= requestStart) return [];
    const request = section.slice(requestStart + "- User asked:".length, resultStart).trim();
    const result = section.slice(resultStart + "- Codex:".length).replace(/\n## Session[\s\S]*$/, "").trim();
    return request && result ? [{ project, time, request, result }] : [];
  });
}
async function loadWorkJournal(defaultWorkspace: string, since: number): Promise<WorkJournalEntry[]> {
  const root = path.dirname(defaultWorkspace);
  const day = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Moscow" })
    .format(new Date(since));
  let projects = [defaultWorkspace];
  try {
    const children = await readdir(root, { withFileTypes: true });
    projects = children.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch { /* keep the configured workspace as the only source */ }
  const entries: WorkJournalEntry[] = [];
  for (const project of [...new Set(projects)]) {
    try {
      const content = await readFile(path.join(project, ".memsearch", "memory", `${day}.md`), "utf8");
      entries.push(...parseWorkJournal(content, project));
    } catch { /* projects without a journal for this day are expected */ }
  }
  return entries.sort((left, right) => compareTimes(left.time, right.time));
}
function isReportableEvent(event: MemoryEvent): boolean {
  if (event.source === "daily-summary" || event.source === "forwarded-voice-batch"
    || event.source === "telegram-voice" || event.source?.startsWith("telegram-voice:") === true) return false;
  return event.kind !== "action" || event.source === "telegram-text" || event.source === "telegram-command"
    || event.source === "telegram-button";
}
function isUserInteraction(event: MemoryEvent): boolean {
  return event.role === "user" || event.source === "telegram-text" || event.source === "telegram-command"
    || event.source === "telegram-button";
}
export function dailyReport(answer: string, since = previousDayWindow().since): string {
  const date = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" })
    .format(new Date(since));
  return [`🌅 **Итог за ${date}**`, answer].filter(Boolean).join("\n\n");
}
function statusLabel(status: WorkItem["status"]): string { return ({ todo: "запланировано", queued: "в очереди", running: "в работе", waiting: "блокер", done: "завершено", cancelled: "отменено" })[status]; }
function projectLabel(project: string | undefined, explicit: string | undefined, aliases: Readonly<Record<string, string>>): string {
  const projectAlias = project ? aliases[project] || aliases[path.basename(project)] : undefined;
  if (projectAlias) return projectAlias;
  if (explicit) return aliases[explicit] || explicit;
  if (!project || project.endsWith("/general-chat")) return "ОБЩЕЕ";
  return path.basename(project);
}
function compact(value: string, limit: number): string { const text = value.replace(/\s+/g, " ").trim(); return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`; }
function digestText(value: string, limit = 100): string {
  const text = value
    .replace(/\[([^\]]+)]\(https?:\/\/[^\s)]+\)/g, "$1")
    .replace(/\[([^\]]+)]\((?:<)?\/[^)]+(?:>)?\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(['"])\/(?:Users|home|var|tmp)\/.*?\1/gi, "")
    .replace(/\/?(?:Users|home|var|tmp)\/\S+/gi, "")
    .replace(/\b(?:PR|pull request)\s*#?\d+\b/gi, "")
    .replace(/\b[0-9a-f]{12,40}\b/gi, "")
    .replace(/[`*_#]/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\(\s+(?=\p{L})/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[—–,:;\s]+$/, "");
  return compact(text, limit);
}
function completionScore(entry: WorkJournalEntry): number {
  const result = entry.result.trim().replace(/^[#*_`\s]+/, "").slice(0, 800);
  const explicitStart = /^(?:готово|исправлено|сделано|закрыто|завершено|обновлено|добавлено|удалено|внесено|отправлено|опубликовано|сохранено|правка готова)/i.test(result);
  const explicitRelease = /(?:исправлен\w*|закрыт\w*|слит\w*|merged|выпущен\w*|разв[её]рнут\w*)[^.]{0,100}(?:production|продакшн|\bпрод\b)/i.test(result)
    || /(?:production|продакшн|\bпрод\b)[^.]{0,100}(?:исправлен\w*|закрыт\w*|слит\w*|merged|выпущен\w*|разв[её]рнут\w*)/i.test(result);
  if (/^готово\s+(?:локально|в\s+ветке)(?:\s|[.!:]|$)/i.test(result)) return 0;
  if (/^(?:разобрал|наш[её]л|проверил|вердикт)/i.test(result) && !explicitStart) return 0;
  if (!explicitStart && !explicitRelease && !/\bmerged\b/i.test(result)) return 0;
  let score = 50;
  if (/production|продакшн|\bпрод\b|deploy|merged|слит|закрыт/i.test(result)) score += 100;
  if (/исправ|устран/i.test(result)) score += 70;
  if (/сохран[её]н|отправлен|опубликован/i.test(result)) score += 20;
  return score;
}
function completionEntries(entries: readonly WorkJournalEntry[], maximum: number): WorkJournalEntry[] {
  const distinct = new Map<string, WorkJournalEntry>();
  for (const entry of entries) {
    if (!completionScore(entry)) continue;
    const request = digestText(entry.request, 180).toLocaleLowerCase("ru-RU");
    const key = request || digestText(entry.result, 180).toLocaleLowerCase("ru-RU");
    if (!distinct.has(key)) distinct.set(key, entry);
  }
  return [...distinct.values()].sort((left, right) => completionScore(right) - completionScore(left)
    || compareTimes(left.time, right.time)).slice(0, maximum);
}
function localCompletionLines(completed: readonly WorkItem[], journal: readonly WorkJournalEntry[],
  aliases: Readonly<Record<string, string>>): string[] {
  const topics = new Map<string, string[]>();
  const add = (project: string, topic: string): void => {
    if (!topic) return;
    const rows = topics.get(project) ?? [];
    const family = completionTopicFamily(topic);
    const duplicate = rows.findIndex((row) => row.toLocaleLowerCase("ru-RU") === topic.toLocaleLowerCase("ru-RU")
      || (family && completionTopicFamily(row) === family));
    if (duplicate < 0) rows.push(topic);
    else if (completionTopicWeight(topic) > completionTopicWeight(rows[duplicate]!)) rows[duplicate] = topic;
    topics.set(project, rows);
  };
  const projects = [...new Set(journal.map((entry) => projectLabel(entry.project, undefined, aliases)))];
  for (const project of projects) {
    const entries = journal.filter((entry) => projectLabel(entry.project, undefined, aliases) === project);
    for (const entry of completionEntries(entries, 12)) {
      if ((topics.get(project)?.length ?? 0) >= 5) break;
      add(project, journalTopic(entry));
    }
  }
  for (const task of completed) {
    const project = projectLabel(task.project, task.projectLabel, aliases);
    add(project, lowerFirst(taskSummary(task.title).replace(/[.!?\s]+$/, "")));
  }
  return [...topics].map(([project, rows]) => `- **${project}:** ${rows.join("; ").replace(/[.!?\s]+$/, "")}.`);
}
function validatedPolishedDigest(value: string, dryDigest: string): string {
  const cleaned = value.trim()
    .replace(/^```(?:markdown)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/^🌅[^\n]*\n+/i, "")
    .trim();
  if (!cleaned || cleaned.length > 3_500) throw new Error("Daily digest AI returned invalid length");
  if (/https?:\/\/|github\.com|\/Users\/|\b[0-9a-f]{12,40}\b/i.test(cleaned)) {
    throw new Error("Daily digest AI returned forbidden technical details");
  }
  const deterministicFacts = dryDigest.split(/\n\*\*Что завершили\*\*/)[0] ?? dryDigest;
  const expectedNumbers = deterministicFacts.match(/\d{1,2}:\d{2}|\d+/g) ?? [];
  const actualNumbers = new Set(cleaned.match(/\d{1,2}:\d{2}|\d+/g) ?? []);
  if (expectedNumbers.some((number) => !actualNumbers.has(number))) {
    throw new Error("Daily digest AI changed or removed numeric facts");
  }
  for (const project of dryDigest.match(/^\*\*[^*\n]+\*\* · \*\*\d+/gm) ?? []) {
    const label = project.match(/^\*\*([^*\n]+)\*\*/)?.[1];
    if (label && !cleaned.includes(label)) throw new Error("Daily digest AI removed a project");
  }
  return cleaned;
}
function journalTopic(entry: WorkJournalEntry): string {
  let request = digestText(entry.request, 130);
  if (!request || /^(?:попробуй(?:\s+сейчас)?|да|ок(?:ей)?|продолжай|закрой(?:\s+на\s+прод.*)?|закрывай(?:\s+на\s+прод.*)?|согласен|конечно|отлично|делай|давай|делаем|выполняй|завис\??|files mentioned by the user)$/i.test(request)
    || /^ок[,!\s]+(?:давай|делаем|согласен)/i.test(request)
    || /^выполни запрос пользователя и верни только полезный результат/i.test(request) || /\/(?:Users|home|var|tmp)\//i.test(entry.request)) {
    request = resultTopic(entry.result);
  }
  request = request
    .replace(/salute-developers\/?GigaAM.*$/i, "оценка модели GigaAM")
    .replace(/^экран\s+прогресс\s*[-—–:]?\s*и\s+все\s+его\s+вкладки.*$/i, "экран «Прогресс» и его вкладки")
    .replace(/^давай\s+убер[её]м\s+нижние\s+кнопки.*бургер.*$/i, "убрали нижние кнопки из бота, оставили только бургер-меню")
    .replace(/^есть\s+незакрытые\s+задачи,?\s+драфты,?\s+мусор\??$/i, "аудит незакрытых задач и черновиков")
    .replace(/^сделай\s+ревью\s*$/i, "ревью проекта")
    .replace(/^внеси\s+правки(?:\s+если\s+считаешь\s+нужным)?\s+и\s+закрой\s+на\s+прод.*$/i, "правки после ревью и выпуск на прод")
    .replace(/^ошибка\s+в\s+тренировке$/i, "исправлена ошибка запуска тренировки на проде")
    .replace(/^проверь\s+программу$/i, "проверка программы")
    .replace(/^проверь\s+/i, "проверка: ")
    .replace(/^посмотри\s+/i, "проверка: ")
    .replace(/^оцени\s+/i, "оценка ")
    .replace(/^исправь\s+/i, "исправление ")
    .replace(/^добавь\s+/i, "добавление ")
    .replace(/^(?:убери|удали)\s+/i, "удаление ")
    .replace(/^обнови\s+/i, "обновление ")
    .replace(/^(?:сделай|внеси)\s+/i, "")
    .replace(/\s+если\s+считаешь\s+нужным/gi, "")
    .replace(/\s+и\s+закрой\s+на\s+прод(?:акшн|uction)?/gi, " и выпуск на прод")
    .trim();
  if (/^в\s+ветке(?:\s|[.!:]|$)/i.test(request)) return "";
  if (/^черновик\s+vc\.ru\b/i.test(request)) request = request.replace(/\s+сохран[её]н.*$/i, " сохранён");
  return lowerFirst(digestText(request, 95));
}
function resultTopic(value: string): string {
  const source = digestText(value, 520);
  const cleaned = digestText(value.replace(/^(?:готово|сделано|исправлено)[.!:\s—–-]*/i, ""), 220);
  if (/^(?:готово[.!:\s—–-]+)?в\s+ветке(?:\s|[.!:]|$)/i.test(source)
    || /^в\s+ветке(?:\s|[.!:]|$)/i.test(cleaned)) return "";
  if (/исправлено на production[\s\S]*ломала запуск тренировок/i.test(source)) return "исправлена ошибка запуска тренировки на проде";
  if (/^остановлены PHP-серверы/i.test(cleaned)) return "остановлены старые тестовые запуски";
  if (/^запись:.*распознана/i.test(cleaned)) return "расшифрована и отредактирована аудиозапись";
  if (/^после создания или дополнения дневниковой записи/i.test(cleaned)) return "убран повторный вывод текста после сохранения дневника";
  if (/20 постеров перегенерированы/i.test(source)) return "20 постеров перегенерированы по комментариям";
  if (/вся генерация завершена[\s\S]*335 из 335/i.test(source)) return "завершена генерация постеров для всей библиотеки упражнений";
  if (/Номина:[\s\S]*Сессия \d+ объединена без дубля/i.test(source)) return "обновлены программа и текущая тренировка Номины без дублей";
  if (/полностью обновлена свежим snapshot с прода/i.test(source)) return "рабочая копия данных обновлена с продакшена";
  if (/оба замечания ревью закрыты[\s\S]*Release ledger/i.test(source)) return "закрыты замечания по процессу выпуска";
  if (/notifications\.php теперь группирует уведомления/i.test(source)) return "уведомления сгруппированы по смысловым разделам";
  if (/Telegram-треды создаются без нестандартного threadSource/i.test(source)) return "исправлено создание и именование новых тем в боте";
  const first = cleaned.split(/(?:[.!?]\s+|;\s+)/, 1)[0] ?? cleaned;
  if (/^(?:закрыто|готово|сделано)(?:\s+полностью|\s+на\s+(?:production|прод(?:е|акшн)?))?$/i.test(first)) return "";
  if (/^вся генерация завершена/i.test(cleaned)) return "завершена генерация постеров";
  return first;
}
function completionTopicFamily(value: string): string | undefined {
  if (/постер|генераци|перегенер/i.test(value)) return "posters";
  if (/дневник|дневников/i.test(value)) return "diary";
  if (/тренировк.*ошиб|ошиб.*трениров/i.test(value)) return "training-error";
  if (/нижн.*кноп|бургер/i.test(value)) return "bot-menu";
  return undefined;
}
function completionTopicWeight(value: string): number {
  if (/всей библиотек|вся генерация|335 из 335/i.test(value)) return 100;
  if (/убрали|исправили|завершили|закрыли/i.test(value)) return 50;
  return 10;
}
function lowerFirst(value: string): string { return value ? value[0]!.toLocaleLowerCase("ru-RU") + value.slice(1) : value; }
function sentence(value: string): string { return value ? value[0]!.toLocaleUpperCase("ru-RU") + value.slice(1).replace(/[.!?\s]+$/, "") + "." : value; }
function taskSummary(value: string): string {
  const text = digestText(value, 130)
    .replace(/^давай\s+убер[её]м\s+/i, "Убрали ")
    .replace(/^убрать\s+/i, "Убрали ")
    .replace(/^исправить\s+/i, "Исправили ")
    .replace(/^добавить\s+/i, "Добавили ")
    .replace(/^обновить\s+/i, "Обновили ")
    .replace(/\.\s+Оставим\s+/i, ", оставили ")
    .replace(/бургер\s+с\s+меню/gi, "бургер-меню");
  return sentence(text);
}
function countLabel(value: number, one: string, few: string, many: string): string {
  const tens = value % 100;
  const units = value % 10;
  const noun = tens >= 11 && tens <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many;
  return `${value} ${noun}`;
}
function formatWeatherBlock(value: string): string {
  const [first = "", ...rest] = value.split("\n");
  const detail = rest.map((line) => digestText(line, 180).replace(
    /([+-]?\d+(?:[.,]\d+)?(?:…[+-]?\d+(?:[.,]\d+)?)?\s*°C|\d+(?:[.,]\d+)?\s*(?:%|мм|км\/ч))/g,
    "**$1**",
  ));
  return [`**${digestText(first, 120)}**`, "", ...detail].join("\n");
}
function morningTopic(value: string): string {
  const text = digestText(value, 80)
    .replace(/^проверь\s+драфты\s+и\s+мусор$/i, "аудит черновиков")
    .replace(/^обновить\s+статью\s+/i, "статья ")
    .replace(/^оценить\s+/i, "оценка ")
    .replace(/^(?:проверь|проверить|сгенерировать|сократить|изучи)\s+/i, "");
  if (/[А-ЯЁ]/.test(text) && !/[а-яё]/.test(text)) return text.toLocaleLowerCase("ru-RU");
  return /^[А-ЯЁ]/.test(text) ? lowerFirst(text) : text;
}
function keepTail(value: string, limit: number): string { return value.length <= limit ? value : value.slice(-limit); }
function statusSymbol(status: WorkItem["status"]): string {
  return status === "running" ? "▶️" : status === "waiting" ? "❓" : status === "queued" ? "⏳" : "•";
}
function compareTimes(left: string, right: string): number { return timeToMinutes(left) - timeToMinutes(right); }
function timeToMinutes(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}
function formatMinutes(value: number): string {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return [hours ? `${hours} ч` : "", minutes || !hours ? `${minutes} мин` : ""].filter(Boolean).join(" ");
}
function representativeEntries(entries: readonly WorkJournalEntry[]): WorkJournalEntry[] {
  const distinct = new Map<string, WorkJournalEntry>();
  for (const entry of entries) distinct.set(compact(entry.request, 180).toLocaleLowerCase("ru-RU"), entry);
  const values = [...distinct.values()];
  const completed = values.filter((entry) => /готов|исправ|добав|удал|обнов|внес|внёс|слит|смерж|merged|разв[её]р|deploy|закры|сделан|проверен|протестирован/i.test(entry.result)
    || /^(?:сделай|исправ|добав|удал|обнов|закрой|внес|внеси|проверь|переработ)/i.test(entry.request.trim()));
  return (completed.length ? completed : values).slice(-2);
}
function generatedWorkspace(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  const base = path.basename(normalized).toLocaleLowerCase("ru-RU");
  return normalized.includes("/.codex/worktrees/") || normalized.includes("/var/folders/") || normalized.startsWith("/tmp/")
    || /\/Documents\/Codex\/\d{4}-\d{2}-\d{2}\//.test(normalized) || base === "f" || base.startsWith("files-mentioned-by-the-user");
}
async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
