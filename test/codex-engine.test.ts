import { describe, expect, it, vi } from "vitest";

import type { AppConfiguration } from "../src/configuration.js";
import { CodexHub } from "../src/codex-engine.js";
import type { EventListener, HostRequestListener, RpcRecord } from "../src/appserver-transport.js";

class FakeTransport {
  events = new Set<EventListener>();
  host?: HostRequestListener;
  calls: Array<{ name: string; payload: RpcRecord }> = [];
  autoComplete = true;
  closeCalls = 0;
  threadSerial = 0;
  async connect() {}
  listen(listener: EventListener) { this.events.add(listener); return () => { this.events.delete(listener); }; }
  answerRequestsFor(_thread: string, listener?: HostRequestListener) { this.host = listener; }
  emit() {}
  async close() { this.closeCalls += 1; }
  async call<T>(name: string, payload: RpcRecord): Promise<T> {
    this.calls.push({ name, payload });
    if (name === "thread/start") return { thread: { id: `thread-${++this.threadSerial}` }, cwd: "/work", model: "gpt" } as T;
    if (name === "thread/resume") return { thread: { id: payload.threadId }, cwd: "/work", model: "gpt" } as T;
    if (name === "turn/start") {
      const threadId = String(payload.threadId);
      queueMicrotask(() => {
        this.notify("turn/started", { threadId, turn: { id: "turn-1" } });
        this.notify("item/agentMessage/delta", { threadId, turnId: "turn-1", delta: "Готово" });
        if (this.autoComplete) this.complete(threadId);
      });
      return { turn: { id: "turn-1" } } as T;
    }
    return {} as T;
  }
  complete(threadId = "thread-1") { this.notify("turn/completed", { threadId, turn: { id: "turn-1", status: "completed" } }); }
  private notify(name: string, payload: RpcRecord) { for (const event of this.events) event(name, payload); }
}

const config: AppConfiguration = {
  telegramToken: "x", allowedUsers: new Set([1]), transcriptionOnlyUsers: new Set(),
  homeDirectory: "/home", dataDirectory: "/data", defaultWorkspace: "/work",
  projectAliases: {}, weatherLocation: "Москва", weatherLatitude: 55.7558, weatherLongitude: 37.6173,
  defaultModel: "gpt", defaultProfile: "review", maxUploadBytes: 1, showUsage: false,
  profiles: [{ id: "review", title: "Review", sandbox: "workspace-write", approvals: "on-request" }],
};

describe("CodexHub", () => {
  it("creates named Telegram threads with the standard interactive source", async () => {
    const transport = new FakeTransport();
    const hub = new CodexHub(config, transport as never);
    const conversation = await hub.conversation("1");

    await conversation.start("/work", "  Убрать нижние кнопки  ");

    expect(transport.calls).toEqual([
      {
        name: "thread/start",
        payload: {
          cwd: "/work",
          model: "gpt",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          ephemeral: false,
        },
      },
      {
        name: "thread/name/set",
        payload: { threadId: "thread-1", name: "Убрать нижние кнопки" },
      },
    ]);
  });

  it("streams a turn through the independent app-server abstraction", async () => {
    const transport = new FakeTransport();
    const hub = new CodexHub(config, transport as never);
    const conversation = await hub.conversation("1");
    const text = vi.fn();
    await conversation.run("Проверка", { text, toolStarted() {}, toolProgress() {}, toolFinished() {} });
    expect(text).toHaveBeenCalledWith("Готово");
    expect(transport.calls.map((call) => call.name)).toEqual(["thread/start", "turn/start"]);
    expect(transport.closeCalls).toBe(1);
    expect(conversation.snapshot().threadId).toBe("thread-1");
  });

  it("releases the writer after each turn and resumes the saved thread on the next turn", async () => {
    const transport = new FakeTransport();
    const hub = new CodexHub(config, transport as never);
    const conversation = await hub.conversation("1", { threadId: "thread-1", workspace: "/work" });
    const observer = { text() {}, toolStarted() {}, toolProgress() {}, toolFinished() {} };

    await conversation.run("Первый ход", observer);
    await conversation.run("Второй ход", observer);

    expect(transport.calls.map((call) => call.name)).toEqual([
      "thread/resume", "turn/start", "thread/resume", "turn/start",
    ]);
    expect(transport.closeCalls).toBe(2);
    expect(conversation.snapshot().threadId).toBe("thread-1");
  });

  it("waits for all concurrent turns before closing the shared app-server", async () => {
    const transport = new FakeTransport();
    transport.autoComplete = false;
    const hub = new CodexHub(config, transport as never);
    const first = await hub.conversation("1");
    const second = await hub.conversation("2");
    const observer = { text() {}, toolStarted() {}, toolProgress() {}, toolFinished() {} };

    const firstRun = first.run("Первый", observer);
    const secondRun = second.run("Второй", observer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.complete("thread-1");
    await firstRun;
    expect(transport.closeCalls).toBe(0);

    transport.complete("thread-2");
    await secondRun;
    expect(transport.closeCalls).toBe(1);
  });

  it("unsubscribes before handing a thread back to Codex on Mac", async () => {
    const transport = new FakeTransport();
    const hub = new CodexHub(config, transport as never);
    await (await hub.conversation("1")).start("/work");

    await hub.detach("1");

    expect(hub.get("1")).toBeUndefined();
    expect(transport.calls.at(-1)).toEqual({
      name: "thread/unsubscribe",
      payload: { threadId: "thread-1" },
    });
    expect(transport.closeCalls).toBe(1);
  });

  it("maps command approvals to host responses", async () => {
    const transport = new FakeTransport();
    transport.autoComplete = false;
    const hub = new CodexHub(config, transport as never);
    const conversation = await hub.conversation("1");
    const running = conversation.run("Проверка", {
      text() {}, toolStarted() {}, toolProgress() {}, toolFinished() {}, approval: async () => "acceptForSession",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = await transport.host?.("item/commandExecution/requestApproval", { threadId: "thread-1", itemId: "cmd", command: "pwd" });
    transport.complete();
    await running;
    expect(response).toEqual({ decision: "acceptForSession" });
  });

  it("forwards app-server user questions instead of silently declining them", async () => {
    const transport = new FakeTransport();
    transport.autoComplete = false;
    const hub = new CodexHub(config, transport as never);
    const conversation = await hub.conversation("1");
    const userInput = vi.fn(async () => ({ calendar: { answers: ["Подключить"] } }));
    const running = conversation.run("Проверка", {
      text() {}, toolStarted() {}, toolProgress() {}, toolFinished() {}, userInput,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = await transport.host?.("item/tool/requestUserInput", {
      threadId: "thread-1", itemId: "question", autoResolutionMs: 60_000,
      questions: [{ id: "calendar", header: "Календарь", question: "Подключить?", isOther: false, isSecret: false,
        options: [{ label: "Подключить", description: "Продолжить" }] }],
    });
    transport.complete();
    await running;
    expect(userInput).toHaveBeenCalledWith({
      autoResolutionMs: 60_000,
      questions: [{ id: "calendar", header: "Календарь", question: "Подключить?", isOther: false, isSecret: false,
        options: [{ label: "Подключить", description: "Продолжить" }] }],
    });
    expect(response).toEqual({ answers: { calendar: { answers: ["Подключить"] } } });
  });
});
