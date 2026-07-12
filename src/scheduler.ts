import { mkdir } from "node:fs/promises";

import type { Bot, Context } from "grammy";

import type { AppConfiguration } from "./configuration.js";
import type { CodexHub, Conversation, TurnObserver } from "./codex-engine.js";
import type { MemoryService } from "./memory-service.js";
import { quietCodexPrompt } from "./prompt-policy.js";
import type { Alarm, AssistantDatabase, WorkItem } from "./storage.js";

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
        } else if (alarm.mode === "digest-morning" || alarm.mode === "digest-evening") {
          await this.send(alarm.owner, this.digest(alarm.owner, alarm.mode === "digest-morning"));
        } else await this.send(alarm.owner, `⏰ ${alarm.label}`);
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

  private digest(owner: string, morning: boolean): string {
    const counts = this.database.counts(owner);
    const inbox = this.database.captures(owner, "new", 100).length;
    const tasks = this.database.tasks(owner, ["running", "waiting", "queued", "todo"], 5);
    return [morning ? "☀️ Доброе утро" : "🌙 Итоги дня", "", `В работе: ${counts.running}`, `Нужен ответ: ${counts.waiting}`,
      `В очереди: ${counts.queued}`, `Запланировано: ${counts.todo}`, `Инбокс: ${inbox}`,
      ...(tasks.length ? ["", ...tasks.map((task) => `${symbol(task)} ${task.title}`)] : [])].join("\n");
  }

  private saveConversation(context: string, conversation: Conversation): void {
    const value = conversation.snapshot();
    this.database.saveConversation({ context, threadId: value.threadId, workspace: value.workspace, model: value.model, effort: value.effort, profileId: value.profileId });
  }

  private async send(owner: string, text: string): Promise<void> {
    for (const chunk of chunks(text, 3900)) await this.bot.api.sendMessage(owner, chunk);
  }
}

function symbol(task: WorkItem): string {
  return task.status === "running" ? "▶️" : task.status === "waiting" ? "❓" : task.status === "queued" ? "⏳" : "•";
}
function keepTail(value: string, limit: number): string { return value.length <= limit ? value : value.slice(-limit); }
function chunks(value: string, limit: number): string[] { const result: string[] = []; let rest = value; while (rest.length > limit) { const newline = rest.lastIndexOf("\n", limit); const space = rest.lastIndexOf(" ", limit); const cut = newline > limit / 2 ? newline : space > limit / 2 ? space : limit; result.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart(); } if (rest) result.push(rest); return result; }
