import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AssistantJob, AssistantJobCounts } from "./storage.js";

export interface RuntimeHealthState {
  updatedAt: number;
  startedAt: number;
  pid: number;
  lastTelegramUpdateAt?: number;
  polling: boolean;
  inflightUpdates: number;
  workerRunning: boolean;
  queue: AssistantJobCounts;
  activeJob?: Pick<AssistantJob, "id" | "context" | "kind" | "attempts" | "maxAttempts" | "startedAt" | "lastEventAt">;
}

export class RuntimeHealthMonitor {
  private readonly startedAt = Date.now();
  private lastTelegramUpdateAt?: number;
  private timer?: NodeJS.Timeout;
  private writing?: Promise<void>;

  constructor(
    private readonly file: string,
    private readonly intervalMs: number,
    private readonly inspect: () => Omit<RuntimeHealthState, "updatedAt" | "startedAt" | "pid" | "lastTelegramUpdateAt">,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.flush();
    this.timer = setInterval(() => { void this.flush(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  telegramUpdate(): void {
    this.lastTelegramUpdateAt = Date.now();
  }

  snapshot(): RuntimeHealthState {
    return {
      updatedAt: Date.now(),
      startedAt: this.startedAt,
      pid: process.pid,
      lastTelegramUpdateAt: this.lastTelegramUpdateAt,
      ...this.inspect(),
    };
  }

  async flush(): Promise<void> {
    if (this.writing) return this.writing;
    const writing = this.writeSnapshot().finally(() => {
      if (this.writing === writing) this.writing = undefined;
    });
    this.writing = writing;
    return writing;
  }

  private async writeSnapshot(): Promise<void> {
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(this.snapshot(), null, 2)}\n`, "utf8");
      await rename(temporary, this.file);
    } catch (error) {
      console.error("Failed to write runtime heartbeat", error);
    }
  }
}
