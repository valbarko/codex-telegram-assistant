import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

export type RpcRecord = Record<string, unknown>;
export type EventListener = (name: string, payload: RpcRecord) => void;
export type HostRequestListener = (name: string, payload: RpcRecord) => Promise<unknown>;

interface DeferredRequest {
  succeed(value: unknown): void;
  fail(error: Error): void;
}

export class AppServerTransport {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: Promise<void>;
  private serial = 0;
  private readonly waiting = new Map<number, DeferredRequest>();
  private readonly events = new Set<EventListener>();
  private readonly hostRequests = new Map<string, HostRequestListener>();
  private intentionalStop = false;

  async connect(): Promise<void> {
    if (!this.connection) {
      this.connection = this.open().catch((error) => {
        this.connection = undefined;
        this.child?.kill("SIGTERM");
        this.child = undefined;
        throw error;
      });
    }
    return this.connection;
  }

  async call<T>(name: string, payload: RpcRecord = {}): Promise<T> {
    await this.connect();
    return this.send<T>(name, payload);
  }

  emit(name: string, payload: RpcRecord = {}): void {
    this.write({ method: name, params: payload });
  }

  listen(listener: EventListener): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  answerRequestsFor(threadId: string, listener?: HostRequestListener): void {
    if (listener) this.hostRequests.set(threadId, listener);
    else this.hostRequests.delete(threadId);
  }

  close(): void {
    this.intentionalStop = true;
    this.child?.kill("SIGTERM");
    this.child = undefined;
    this.connection = undefined;
    this.rejectWaiting(new Error("app-server connection closed"));
  }

  private async open(): Promise<void> {
    this.intentionalStop = false;
    const executable = codexExecutable();
    const child = spawn(executable, ["app-server", "--stdio"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    child.stderr.on("data", (data: Buffer) => {
      const message = data.toString("utf8").trim();
      if (message) console.error(`app-server stderr: ${message}`);
    });
    child.once("error", (error) => this.disconnected(error));
    child.once("exit", (code, signal) => {
      if (!this.intentionalStop) this.disconnected(new Error(`app-server exited: ${code ?? signal ?? "unknown"}`));
    });
    await this.send("initialize", {
      clientInfo: { name: "codex_telegram_assistant", title: "Codex Telegram Assistant", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.emit("initialized");
  }

  private send<T>(name: string, payload: RpcRecord): Promise<T> {
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { succeed: resolve as (value: unknown) => void, fail: reject });
      try {
        this.write({ id, method: name, params: payload });
      } catch (error) {
        this.waiting.delete(id);
        reject(asError(error));
      }
    });
  }

  private write(message: RpcRecord): void {
    if (!this.child?.stdin.writable) throw new Error("app-server is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: RpcRecord;
    try {
      message = JSON.parse(line) as RpcRecord;
    } catch {
      console.error("Discarding malformed app-server output");
      return;
    }
    const method = typeof message.method === "string" ? message.method : undefined;
    if (method && message.id !== undefined) {
      void this.answerHost(message.id as string | number, method, object(message.params));
      return;
    }
    if (typeof message.id === "number") {
      const deferred = this.waiting.get(message.id);
      if (!deferred) return;
      this.waiting.delete(message.id);
      if (message.error) deferred.fail(new Error(rpcError(message.error)));
      else deferred.succeed(message.result);
      return;
    }
    if (method) {
      for (const listener of this.events) listener(method, object(message.params));
    }
  }

  private async answerHost(id: string | number, name: string, payload: RpcRecord): Promise<void> {
    const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
    try {
      const handler = this.hostRequests.get(threadId);
      const result = handler ? await handler(name, payload) : safeDefault(name);
      this.write({ id, result });
    } catch (error) {
      this.write({ id, error: { code: -32000, message: asError(error).message } });
    }
  }

  private disconnected(error: Error): void {
    this.child = undefined;
    this.connection = undefined;
    this.rejectWaiting(error);
    for (const listener of this.events) listener("transport/disconnected", { message: error.message });
  }

  private rejectWaiting(error: Error): void {
    for (const deferred of this.waiting.values()) deferred.fail(error);
    this.waiting.clear();
  }
}

export function codexExecutable(): string {
  const configured = process.env.CODEX_CLI_PATH?.trim();
  if (configured) return configured;
  const home = process.env.HOME || "";
  const candidates = [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    path.join(home, ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  return candidates.find((candidate) => existsSync(candidate)) || "codex";
}

function safeDefault(name: string): unknown {
  if (name.includes("requestApproval")) return name.includes("permissions") ? { permissions: {}, scope: "turn" } : { decision: "decline" };
  if (name === "item/tool/requestUserInput") return { answers: {} };
  throw new Error(`Unsupported host request: ${name}`);
}

function object(value: unknown): RpcRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RpcRecord : {};
}

function rpcError(value: unknown): string {
  const details = object(value);
  return `${details.code ?? "RPC"}: ${typeof details.message === "string" ? details.message : JSON.stringify(value)}`;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
