import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantJobBlockedError, AssistantJobTimeoutError, AssistantJobWorker,
  classifyAssistantJobError } from "../src/assistant-job-worker.js";
import { AssistantDatabase } from "../src/storage.js";

describe("AssistantJobWorker", () => {
  let folder: string;
  let database: AssistantDatabase;
  let worker: AssistantJobWorker | undefined;

  beforeEach(() => {
    folder = mkdtempSync(path.join(tmpdir(), "cta-jobs-"));
    database = new AssistantDatabase(path.join(folder, "assistant.sqlite"));
  });
  afterEach(() => {
    worker?.stop();
    database.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it("automatically retries a timeout and delivers the saved result once", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new AssistantJobTimeoutError())
      .mockResolvedValueOnce("Готово");
    const succeeded = vi.fn(async () => undefined);
    worker = new AssistantJobWorker(database, { execute, succeeded }, [1]);
    const job = enqueue(database, 3);

    worker.start();
    await waitUntil(() => database.assistantJob(job.id)?.notifiedAt !== undefined);

    expect(database.assistantJob(job.id)).toMatchObject({ state: "succeeded", attempts: 2, result: "Готово" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(succeeded).toHaveBeenCalledTimes(1);
  });

  it("does not blindly retry a permanent article postcondition failure", async () => {
    const execute = vi.fn(async () => { throw new AssistantJobBlockedError("нет файлов", "article_incomplete"); });
    const terminalFailure = vi.fn(async () => undefined);
    worker = new AssistantJobWorker(database, { execute, terminalFailure }, [1]);
    const job = enqueue(database, 3);

    worker.start();
    await waitUntil(() => database.assistantJob(job.id)?.notifiedAt !== undefined);

    expect(database.assistantJob(job.id)).toMatchObject({ state: "blocked", attempts: 1, errorClass: "article_incomplete" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(terminalFailure).toHaveBeenCalledTimes(1);
  });

  it("delivers a persisted result after restart without executing the job again", async () => {
    const execute = vi.fn(async () => "Сохранённый ответ");
    const failedDelivery = vi.fn(async () => { throw new Error("Telegram offline"); });
    worker = new AssistantJobWorker(database, { execute, succeeded: failedDelivery }, [1]);
    const job = enqueue(database, 3);

    worker.start();
    await waitUntil(() => database.assistantJob(job.id)?.state === "succeeded");
    await waitUntil(() => failedDelivery.mock.calls.length === 1);
    expect(database.assistantJob(job.id)?.notifiedAt).toBeUndefined();
    worker.stop();

    const recoveredDelivery = vi.fn(async () => undefined);
    const recoveredExecute = vi.fn(async () => "Не должен запускаться");
    worker = new AssistantJobWorker(database, { execute: recoveredExecute, succeeded: recoveredDelivery }, [1]);
    worker.start();
    await waitUntil(() => database.assistantJob(job.id)?.notifiedAt !== undefined);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(recoveredExecute).not.toHaveBeenCalled();
    expect(recoveredDelivery).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), "Сохранённый ответ");
  });
});

describe("classifyAssistantJobError", () => {
  it("separates transient transport failures from permission and unknown failures", () => {
    expect(classifyAssistantJobError(new Error("app-server disconnected"))).toMatchObject({ kind: "retryable" });
    expect(classifyAssistantJobError(new Error("Operation not permitted"))).toMatchObject({ kind: "blocked", errorClass: "permission" });
    expect(classifyAssistantJobError(new Error("bad output"))).toMatchObject({ kind: "failed", errorClass: "unexpected" });
  });
});

function enqueue(database: AssistantDatabase, maxAttempts: number) {
  return database.enqueueAssistantJob({
    owner: "1", context: "1", chatId: "1", body: "Задание", prompt: "Задание", fingerprint: "job",
    kind: "assistant", maxAttempts,
  }).job;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for job worker");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
