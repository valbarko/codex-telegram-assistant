import { describe, expect, it } from "vitest";

import type { StoredThread } from "../src/codex-engine.js";
import type { WorkItem } from "../src/storage.js";
import { countActiveWork, groupActiveWork, internalAssistantWorkspace, internalWorkThread, mergeActiveWork } from "../src/work-dashboard.js";

const task = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  id: "task-1", owner: "1", title: "Задача из Telegram", prompt: "Задача из Telegram", status: "todo",
  createdAt: 100, changedAt: 100, ...overrides,
});

const thread = (overrides: Partial<StoredThread> = {}): StoredThread => ({
  id: "thread-1", title: "Задача из Codex", workspace: "/work/helper", updatedAt: 200, archived: false, ...overrides,
});

describe("unified work dashboard", () => {
  it("merges Telegram tasks and Codex threads without duplicating linked work", () => {
    const items = mergeActiveWork([
      task({ id: "active", threadId: "linked", project: "/work/helper", status: "waiting" }),
      task({ id: "done", threadId: "finished", status: "done" }),
    ], [
      thread({ id: "linked", title: "Linked" }),
      thread({ id: "finished", title: "Finished" }),
      thread({ id: "standalone", title: "Standalone", workspace: "/work/trainer", updatedAt: 300 }),
    ], { helper: "ПОМОЩНИК", trainer: "ТРЕНЕР" });

    expect(items.map((item) => [item.id, item.kind, item.status, item.projectLabel])).toEqual([
      ["standalone", "thread", "running", "ТРЕНЕР"],
      ["active", "task", "waiting", "ПОМОЩНИК"],
    ]);
    expect(countActiveWork(items)).toEqual({ running: 1, waiting: 1, queued: 0, todo: 0 });
  });

  it("groups projects by activity and excludes internal threads", () => {
    const items = mergeActiveWork([
      task({ id: "unassigned", title: "Без проекта", changedAt: 250 }),
    ], [
      thread({ id: "helper", workspace: "/work/helper", updatedAt: 300 }),
      thread({ id: "digest", workspace: "", updatedAt: 400 }),
    ], { helper: "ПОМОЩНИК" }, new Set(["digest"]));

    expect(groupActiveWork(items).map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ["ПОМОЩНИК", ["helper"]],
      ["Без проекта", ["unassigned"]],
    ]);
  });

  it("uses the configured project alias instead of a raw explicit basename", () => {
    const items = mergeActiveWork([
      task({ project: "/work/helper", projectLabel: "helper" }),
    ], [], { helper: "ПОМОЩНИК" });

    expect(items[0]?.projectLabel).toBe("ПОМОЩНИК");
  });

  it("recognizes unnamed internal helper threads", () => {
    expect(internalWorkThread(thread({ title: "Выполни запрос пользователя и верни только полезный результат. Не описывай внутренние skills." }))).toBe(true);
    expect(internalWorkThread(thread({ title: "Проверить утреннюю сводку" }))).toBe(false);
  });

  it("recognizes generated assistant data workspaces", () => {
    expect(internalAssistantWorkspace("/data/assistant/general-chat", "/data/assistant")).toBe(true);
    expect(internalAssistantWorkspace("/work/codex-telegram-assistant", "/data/assistant")).toBe(false);
  });
});
