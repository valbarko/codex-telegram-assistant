import type { AssistantJob } from "./storage.js";
import { AssistantDatabase } from "./storage.js";

export type AssistantJobFailureKind = "retryable" | "blocked" | "failed";

export interface AssistantJobFailure {
  kind: AssistantJobFailureKind;
  errorClass: string;
  message: string;
}

export interface AssistantJobWorkerHooks {
  execute(job: AssistantJob): Promise<string>;
  succeeded?(job: AssistantJob, result: string): Promise<void>;
  retryScheduled?(job: AssistantJob, failure: AssistantJobFailure, retryAt: number): Promise<void>;
  terminalFailure?(job: AssistantJob, failure: AssistantJobFailure): Promise<void>;
}

export class AssistantJobBlockedError extends Error {
  constructor(message: string, readonly errorClass = "blocked") {
    super(message);
    this.name = "AssistantJobBlockedError";
  }
}

export class AssistantJobTimeoutError extends Error {
  constructor(message = "Codex stopped producing events") {
    super(message);
    this.name = "AssistantJobTimeoutError";
  }
}

export class AssistantJobWorker {
  private timer?: NodeJS.Timeout;
  private pumping = false;
  private started = false;

  constructor(
    private readonly database: AssistantDatabase,
    private readonly hooks: AssistantJobWorkerHooks,
    private readonly retryDelaysMs: readonly number[] = [10_000, 60_000, 5 * 60_000],
  ) {}

  start(): { retried: number; failed: number } {
    if (this.started) return { retried: 0, failed: 0 };
    this.started = true;
    const recovered = this.database.recoverAssistantJobs();
    this.schedule(0);
    return recovered;
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  notify(): void {
    if (!this.started) return;
    this.schedule(0);
  }

  isRunning(): boolean {
    return this.pumping;
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump().catch((error) => console.error("Assistant job worker failed", error));
    }, Math.max(0, Math.min(delayMs, 2_147_000_000)));
    this.timer.unref?.();
  }

  private async pump(): Promise<void> {
    if (!this.started || this.pumping) return;
    this.pumping = true;
    try {
      await this.deliverPendingNotifications();
      while (this.started) {
        const job = this.database.claimAssistantJob();
        if (!job) break;
        await this.execute(job);
      }
    } finally {
      this.pumping = false;
      if (!this.started) return;
      const next = this.database.nextAssistantJobAt();
      if (next !== undefined) this.schedule(Math.max(0, next - Date.now()));
      else if (this.database.pendingAssistantJobNotifications(1).length) this.schedule(30_000);
    }
  }

  private async execute(job: AssistantJob): Promise<void> {
    try {
      const result = await this.hooks.execute(job);
      if (this.database.completeAssistantJob(job.id, result)) {
        await this.deliverNotification(this.database.assistantJob(job.id)!);
      }
    } catch (error) {
      const current = this.database.assistantJob(job.id);
      if (!current || current.state === "cancelled") return;
      const failure = classifyAssistantJobError(error);
      if (failure.kind === "retryable" && current.attempts < current.maxAttempts) {
        const retryAt = Date.now() + this.retryDelay(current.attempts);
        if (this.database.retryAssistantJob(job.id, failure.errorClass, failure.message, retryAt)) {
          await this.hooks.retryScheduled?.(this.database.assistantJob(job.id)!, failure, retryAt)
            .catch((notifyError) => console.error("Failed to announce assistant retry", notifyError));
        }
        return;
      }
      const terminal: AssistantJobFailure = failure.kind === "retryable"
        ? { ...failure, kind: "failed" }
        : failure;
      if (this.database.finishAssistantJob(job.id, terminal.kind === "blocked" ? "blocked" : "failed",
        terminal.errorClass, terminal.message)) {
        await this.deliverNotification(this.database.assistantJob(job.id)!);
      }
    }
  }

  private retryDelay(attempt: number): number {
    return this.retryDelaysMs[Math.min(Math.max(0, attempt - 1), this.retryDelaysMs.length - 1)] ?? 60_000;
  }

  private async deliverPendingNotifications(): Promise<void> {
    for (const job of this.database.pendingAssistantJobNotifications()) await this.deliverNotification(job);
  }

  private async deliverNotification(job: AssistantJob): Promise<void> {
    try {
      if (job.state === "succeeded") {
        await this.hooks.succeeded?.(job, job.result ?? "Готово");
      } else {
        await this.hooks.terminalFailure?.(job, {
          kind: job.state === "blocked" ? "blocked" : "failed",
          errorClass: job.errorClass ?? "unexpected",
          message: job.error ?? "Assistant job failed",
        });
      }
      this.database.markAssistantJobNotified(job.id);
    } catch (notifyError) {
      console.error("Failed to deliver assistant job notification", notifyError);
    }
  }
}

export function classifyAssistantJobError(error: unknown): AssistantJobFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AssistantJobBlockedError) {
    return { kind: "blocked", errorClass: error.errorClass, message };
  }
  if (error instanceof AssistantJobTimeoutError || /(?:timed?\s*out|timeout|stopped producing events)/iu.test(message)) {
    return { kind: "retryable", errorClass: "timeout", message };
  }
  if (/(?:app-server disconnected|connection (?:closed|reset)|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|\b429\b|\b5\d\d\b)/iu.test(message)) {
    return { kind: "retryable", errorClass: "transport", message };
  }
  if (/already has an active writer/iu.test(message)) {
    return { kind: "retryable", errorClass: "active_writer", message };
  }
  if (/(?:permission denied|operation not permitted|not writable|read-only file system)/iu.test(message)) {
    return { kind: "blocked", errorClass: "permission", message };
  }
  if (/(?:token_expired|invalid[_ ]api[_ ]key|unauthori[sz]ed|\b401\b|insufficient[_ ]quota|quota exceeded)/iu.test(message)) {
    return { kind: "blocked", errorClass: "authentication", message };
  }
  return { kind: "failed", errorClass: "unexpected", message };
}
