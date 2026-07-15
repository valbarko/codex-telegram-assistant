import { describe, expect, it, vi } from "vitest";

import type { AppConfiguration } from "../src/configuration.js";
import { CodexHub } from "../src/codex-engine.js";
import type { EventListener, HostRequestListener, RpcRecord } from "../src/appserver-transport.js";

class FakeTransport {
  event?: EventListener;
  host?: HostRequestListener;
  calls: Array<{ name: string; payload: RpcRecord }> = [];
  autoComplete = true;
  async connect() {}
  listen(listener: EventListener) { this.event = listener; return () => { this.event = undefined; }; }
  answerRequestsFor(_thread: string, listener?: HostRequestListener) { this.host = listener; }
  emit() {}
  close() {}
  async call<T>(name: string, payload: RpcRecord): Promise<T> {
    this.calls.push({ name, payload });
    if (name === "thread/start" || name === "thread/resume") return { thread: { id: "thread-1" }, cwd: "/work", model: "gpt" } as T;
    if (name === "turn/start") {
      queueMicrotask(() => {
        this.event?.("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
        this.event?.("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", delta: "Готово" });
        if (this.autoComplete) this.complete();
      });
      return { turn: { id: "turn-1" } } as T;
    }
    return {} as T;
  }
  complete() { this.event?.("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }); }
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
