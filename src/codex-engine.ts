import type { ExecutionProfile, AppConfiguration } from "./configuration.js";
import { AppServerTransport, type RpcRecord } from "./appserver-transport.js";

export type AssistantInput = string | { text?: string; images?: readonly string[]; fileNote?: string };
export type ApprovalChoice = "accept" | "acceptForSession" | "decline" | "cancel";

export interface ApprovalPrompt {
  category: "command" | "files" | "permissions";
  itemId: string;
  command?: string;
  directory?: string;
  reason?: string;
  root?: string;
}

export interface UserInputOption { label: string; description: string; }
export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: readonly UserInputOption[];
}
export interface UserInputPrompt {
  questions: readonly UserInputQuestion[];
  autoResolutionMs?: number;
}
export type UserInputAnswers = Record<string, { answers: string[] }>;

export interface TurnObserver {
  text(delta: string): void;
  toolStarted(id: string, label: string): void;
  toolProgress(id: string, delta: string): void;
  toolFinished(id: string, failed: boolean): void;
  plan?(steps: readonly { text: string; done: boolean }[]): void;
  usage?(last: TokenCount, total: TokenCount): void;
  activity?(event: string): void;
  approval?(prompt: ApprovalPrompt): Promise<ApprovalChoice>;
  userInput?(prompt: UserInputPrompt): Promise<UserInputAnswers>;
}

export class CodexTurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Codex stopped producing events for ${timeoutMs} ms`);
    this.name = "CodexTurnTimeoutError";
  }
}

export class CodexTurnInterruptedError extends Error {
  constructor() {
    super("Codex turn was interrupted");
    this.name = "CodexTurnInterruptedError";
  }
}

export interface TokenCount {
  input: number;
  cached: number;
  output: number;
}

export interface ConversationSnapshot {
  threadId?: string;
  workspace: string;
  model?: string;
  effort?: string;
  profileId: string;
  running: boolean;
  tokens: TokenCount;
}

export interface StoredThread {
  id: string;
  title: string;
  workspace: string;
  model?: string;
  updatedAt: number;
  archived: boolean;
}

interface ThreadOpenResult {
  thread: { id: string };
  cwd?: string;
  model?: string;
  reasoningEffort?: string | null;
}

interface TurnOpenResult {
  turn: { id: string };
}

interface RuntimeLifecycle {
  use<T>(operation: () => Promise<T>): Promise<T>;
  releaseWriters(): Promise<void>;
}

export class CodexHub {
  private readonly conversations = new Map<string, Conversation>();
  private runtimeUsers = 0;
  private closeRequested = false;
  private runtimeClosing?: Promise<void>;

  constructor(
    private readonly configuration: AppConfiguration,
    readonly transport = new AppServerTransport(),
  ) {}

  async conversation(context: string, saved?: Partial<ConversationSnapshot>): Promise<Conversation> {
    const existing = this.conversations.get(context);
    if (existing) return existing;
    const created = new Conversation(this.transport, this.configuration, {
      use: (operation) => this.useRuntime(operation),
      releaseWriters: () => this.releaseWriters(),
    }, saved);
    this.conversations.set(context, created);
    return created;
  }

  get(context: string): Conversation | undefined {
    return this.conversations.get(context);
  }

  remove(context: string): void {
    this.conversations.get(context)?.release();
    this.conversations.delete(context);
  }

  async detach(context: string): Promise<void> {
    const conversation = this.conversations.get(context);
    if (!conversation) return;
    await conversation.detach();
    this.conversations.delete(context);
  }

  async threads(limit = 50, query?: string): Promise<StoredThread[]> {
    const response = await this.useRuntime(() => this.transport.call<{ data?: unknown[] }>("thread/list", {
      limit, archived: false, searchTerm: query || null, sortKey: "updated_at", sortDirection: "desc",
    }));
    return (response.data ?? []).map(readStoredThread).filter((thread): thread is StoredThread => thread !== null);
  }

  async archive(threadId: string): Promise<void> {
    await this.useRuntime(() => this.transport.call("thread/archive", { threadId }));
  }

  async rename(threadId: string, name: string): Promise<void> {
    await this.useRuntime(() => this.transport.call("thread/name/set", { threadId, name }));
  }

  async fork(threadId: string): Promise<string> {
    const response = await this.useRuntime(() => this.transport.call<{ thread: { id: string } }>("thread/fork", { threadId }));
    return response.thread.id;
  }

  shutdown(): void {
    for (const conversation of this.conversations.values()) conversation.release();
    this.conversations.clear();
    void this.transport.close();
  }

  private async useRuntime<T>(operation: () => Promise<T>): Promise<T> {
    if (this.runtimeClosing) await this.runtimeClosing;
    this.runtimeUsers += 1;
    try {
      return await operation();
    } finally {
      this.runtimeUsers -= 1;
      if (this.runtimeUsers === 0 && this.closeRequested) await this.closeRuntime();
    }
  }

  private async releaseWriters(): Promise<void> {
    this.closeRequested = true;
    if (this.runtimeUsers === 0) await this.closeRuntime();
  }

  private async closeRuntime(): Promise<void> {
    if (this.runtimeClosing) return this.runtimeClosing;
    this.closeRequested = false;
    for (const conversation of this.conversations.values()) conversation.runtimeClosed();
    const closing = this.transport.close().finally(() => {
      if (this.runtimeClosing === closing) this.runtimeClosing = undefined;
    });
    this.runtimeClosing = closing;
    return closing;
  }
}

export class Conversation {
  private threadId?: string;
  private workspace: string;
  private model?: string;
  private effort?: string;
  private profileId: string;
  private turnId?: string;
  private tokens: TokenCount = { input: 0, cached: 0, output: 0 };
  private runtimeAttached = false;

  constructor(
    private readonly transport: AppServerTransport,
    private readonly configuration: AppConfiguration,
    private readonly lifecycle: RuntimeLifecycle,
    saved?: Partial<ConversationSnapshot>,
  ) {
    this.threadId = saved?.threadId;
    this.workspace = saved?.workspace || configuration.defaultWorkspace;
    this.model = saved?.model || configuration.defaultModel;
    this.effort = saved?.effort;
    this.profileId = saved?.profileId || configuration.defaultProfile;
  }

  snapshot(): ConversationSnapshot {
    return {
      threadId: this.threadId,
      workspace: this.workspace,
      model: this.model,
      effort: this.effort,
      profileId: this.profileId,
      running: Boolean(this.turnId),
      tokens: { ...this.tokens },
    };
  }

  selectProfile(id: string): ExecutionProfile {
    const profile = this.configuration.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`Unknown profile: ${id}`);
    this.profileId = id;
    return profile;
  }

  selectModel(model: string): void {
    this.model = model;
  }

  selectEffort(effort: string): void {
    this.effort = effort;
  }

  selectWorkspace(workspace: string): void {
    this.ensureIdle();
    this.workspace = workspace;
  }

  async start(workspace = this.workspace, name?: string): Promise<ConversationSnapshot> {
    return this.lifecycle.use(() => this.startAttached(workspace, name));
  }

  private async startAttached(workspace = this.workspace, name?: string): Promise<ConversationSnapshot> {
    this.ensureIdle();
    const profile = this.profile();
    const result = await this.transport.call<ThreadOpenResult>("thread/start", {
      cwd: workspace,
      model: this.model ?? null,
      sandbox: profile.sandbox,
      approvalPolicy: profile.approvals,
      approvalsReviewer: "user",
      ephemeral: false,
    });
    this.threadId = result.thread.id;
    this.workspace = result.cwd || workspace;
    this.model = result.model || this.model;
    this.effort = result.reasoningEffort || this.effort;
    this.runtimeAttached = true;
    const threadName = name?.trim();
    if (threadName) {
      try {
        await this.transport.call("thread/name/set", { threadId: this.threadId, name: threadName });
      } catch (error) {
        console.error(`Failed to name Codex thread ${this.threadId}`, error);
      }
    }
    return this.snapshot();
  }

  async resume(threadId: string): Promise<ConversationSnapshot> {
    return this.lifecycle.use(() => this.resumeAttached(threadId));
  }

  private async resumeAttached(threadId: string): Promise<ConversationSnapshot> {
    this.ensureIdle();
    const profile = this.profile();
    const result = await this.transport.call<ThreadOpenResult>("thread/resume", {
      threadId,
      cwd: this.workspace,
      model: this.model ?? null,
      sandbox: profile.sandbox,
      approvalPolicy: profile.approvals,
      approvalsReviewer: "user",
    });
    this.threadId = result.thread.id || threadId;
    this.workspace = result.cwd || this.workspace;
    this.model = result.model || this.model;
    this.effort = result.reasoningEffort || this.effort;
    this.runtimeAttached = true;
    return this.snapshot();
  }

  private async forkAttached(threadId: string): Promise<ConversationSnapshot> {
    this.ensureIdle();
    const profile = this.profile();
    const result = await this.transport.call<ThreadOpenResult>("thread/fork", {
      threadId,
      cwd: this.workspace,
      model: this.model ?? null,
      sandbox: profile.sandbox,
      approvalPolicy: profile.approvals,
      approvalsReviewer: "user",
      ephemeral: false,
      excludeTurns: true,
    });
    this.threadId = result.thread.id;
    this.workspace = result.cwd || this.workspace;
    this.model = result.model || this.model;
    this.effort = result.reasoningEffort || this.effort;
    this.runtimeAttached = true;
    return this.snapshot();
  }

  private async attachForRun(): Promise<void> {
    if (!this.threadId) {
      await this.startAttached();
      return;
    }
    if (this.runtimeAttached) return;
    const occupiedThreadId = this.threadId;
    try {
      await this.resumeAttached(occupiedThreadId);
    } catch (error) {
      if (!isActiveWriterConflict(error)) throw error;
      console.warn(`Codex thread ${occupiedThreadId} has an active writer; continuing in a fork`);
      try {
        await this.forkAttached(occupiedThreadId);
      } catch (forkError) {
        console.error(`Failed to fork occupied Codex thread ${occupiedThreadId}; starting a fresh thread`, forkError);
        await this.startAttached(this.workspace);
      }
    }
  }

  async run(input: AssistantInput, observer: TurnObserver): Promise<void> {
    await this.lifecycle.use(async () => {
      try {
        await this.runAttached(input, observer);
      } finally {
        await this.lifecycle.releaseWriters();
      }
    });
  }

  private async runAttached(input: AssistantInput, observer: TurnObserver): Promise<void> {
    await this.attachForRun();
    if (this.turnId) throw new Error("A turn is already running");
    const threadId = this.threadId!;
    const profile = this.profile();
    const timeoutMs = this.configuration.assistantInactivityTimeoutMs;
    let complete!: () => void;
    let fail!: (error: Error) => void;
    let rejectWatchdog!: (error: Error) => void;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    const result = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    const watchdog = new Promise<never>((_resolve, reject) => { rejectWatchdog = reject; });
    const outputs = new Map<string, string>();
    const settle = (error?: Error): void => {
      if (finished) return;
      finished = true;
      error ? fail(error) : complete();
    };
    const touch = (name: string): void => {
      observer.activity?.(name);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const error = new CodexTurnTimeoutError(timeoutMs);
        rejectWatchdog(error);
        if (this.turnId) {
          void this.transport.call("turn/interrupt", { threadId, turnId: this.turnId }).catch(() => undefined);
        }
      }, timeoutMs);
    };
    touch("turn/requested");
    const stopListening = this.transport.listen((name, payload) => {
      if (name === "transport/disconnected") {
        touch(name);
        return settle(new Error(text(payload, "message") || "app-server disconnected"));
      }
      if (payload.threadId !== threadId) return;
      const eventTurn = text(payload, "turnId") || text(record(payload.turn), "id");
      if (this.turnId && eventTurn && eventTurn !== this.turnId) return;
      touch(name);
      if (name === "turn/started" && eventTurn) this.turnId = eventTurn;
      else if (name === "item/agentMessage/delta") observer.text(text(payload, "delta"));
      else if (name === "item/started") started(record(payload.item), observer);
      else if (name === "item/commandExecution/outputDelta") progress(payload, observer, outputs);
      else if (name === "item/mcpToolCall/progress") observer.toolProgress(text(payload, "itemId"), text(payload, "message"));
      else if (name === "item/completed") completed(record(payload.item), observer, outputs);
      else if (name === "turn/plan/updated") observer.plan?.(readPlan(payload.plan));
      else if (name === "thread/tokenUsage/updated") {
        const usage = record(payload.tokenUsage);
        const total = readTokens(record(usage.total));
        const last = readTokens(record(usage.last));
        this.tokens = total;
        observer.usage?.(last, total);
      } else if (name === "error" && payload.willRetry !== true) {
        settle(new Error(text(record(payload.error), "message") || "Codex failed"));
      } else if (name === "turn/completed") {
        const turn = record(payload.turn);
        const status = text(turn, "status");
        if (status === "completed") settle();
        else if (status === "interrupted") settle(new CodexTurnInterruptedError());
        else settle(new Error(text(record(turn.error), "message") || `Codex turn ${status || "failed"}`));
      }
    });
    this.transport.answerRequestsFor(threadId, async (name, payload) => {
      touch(name);
      try {
        return await this.answerHostRequest(name, payload, observer);
      } finally {
        touch(`${name}/resolved`);
      }
    });
    try {
      const opened = await Promise.race([
        this.transport.call<TurnOpenResult>("turn/start", {
          threadId,
          input: toProtocolInput(input),
          cwd: this.workspace,
          model: this.model ?? null,
          effort: this.effort ?? null,
          sandbox: profile.sandbox,
          approvalPolicy: profile.approvals,
          approvalsReviewer: "user",
        }),
        watchdog,
      ]);
      this.turnId = opened.turn.id;
      await Promise.race([result, watchdog]);
    } finally {
      if (timer) clearTimeout(timer);
      stopListening();
      this.transport.answerRequestsFor(threadId);
      this.turnId = undefined;
    }
  }

  async steer(input: AssistantInput): Promise<void> {
    if (!this.threadId || !this.turnId) throw new Error("No active turn");
    await this.transport.call("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: toProtocolInput(input) });
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return;
    await this.transport.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
  }

  release(): void {
    void this.detach().catch(() => undefined);
  }

  async detach(): Promise<void> {
    const threadId = this.threadId;
    if (this.turnId) await this.interrupt();
    this.turnId = undefined;
    this.threadId = undefined;
    if (threadId && this.runtimeAttached) {
      await this.lifecycle.use(() => this.transport.call("thread/unsubscribe", { threadId }));
    }
    this.runtimeAttached = false;
    await this.lifecycle.releaseWriters();
  }

  runtimeClosed(): void {
    this.runtimeAttached = false;
  }

  private profile(): ExecutionProfile {
    return this.configuration.profiles.find((candidate) => candidate.id === this.profileId)
      ?? this.configuration.profiles[0]!;
  }

  private ensureIdle(): void {
    if (this.turnId) throw new Error("Cannot switch thread during a running turn");
  }

  private async answerHostRequest(name: string, payload: RpcRecord, observer: TurnObserver): Promise<unknown> {
    if (name === "item/tool/requestUserInput") {
      const prompt = readUserInput(payload);
      return { answers: observer.userInput ? await observer.userInput(prompt) : {} };
    }
    const requested = approvalFrom(name, payload);
    if (!requested) throw new Error(`Unsupported host request: ${name}`);
    const choice = observer.approval ? await observer.approval(requested) : "decline";
    if (name === "item/permissions/requestApproval") {
      const permissions = record(payload.permissions);
      return {
        permissions: choice === "accept" || choice === "acceptForSession" ? compactPermissions(permissions) : {},
        scope: choice === "acceptForSession" ? "session" : "turn",
      };
    }
    return { decision: choice };
  }
}

function isActiveWriterConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already has an active writer/iu.test(message);
}

function readUserInput(payload: RpcRecord): UserInputPrompt {
  const questions = (Array.isArray(payload.questions) ? payload.questions : []).map((value): UserInputQuestion | null => {
    const question = record(value);
    const id = text(question, "id");
    if (!id) return null;
    const options = Array.isArray(question.options) ? question.options.map((option) => {
      const item = record(option);
      return { label: text(item, "label"), description: text(item, "description") };
    }).filter((option) => option.label) : undefined;
    return {
      id, header: text(question, "header"), question: text(question, "question"),
      isOther: question.isOther === true, isSecret: question.isSecret === true, options,
    };
  }).filter((question): question is UserInputQuestion => question !== null);
  return { questions, autoResolutionMs: typeof payload.autoResolutionMs === "number" ? payload.autoResolutionMs : undefined };
}

function toProtocolInput(input: AssistantInput): RpcRecord[] {
  if (typeof input === "string") return [{ type: "text", text: input, text_elements: [] }];
  const result: RpcRecord[] = [];
  const words = [input.fileNote, input.text].filter(Boolean).join("\n\n");
  if (words) result.push({ type: "text", text: words, text_elements: [] });
  for (const image of input.images ?? []) result.push({ type: "localImage", path: image });
  return result.length ? result : [{ type: "text", text: "", text_elements: [] }];
}

function started(item: RpcRecord, observer: TurnObserver): void {
  const id = text(item, "id");
  if (item.type === "commandExecution") observer.toolStarted(id, text(item, "command") || "command");
  else if (item.type === "mcpToolCall") observer.toolStarted(id, `mcp:${text(item, "server")}/${text(item, "tool")}`);
  else if (item.type === "dynamicToolCall") observer.toolStarted(id, text(item, "tool") || "tool");
  else if (item.type === "webSearch") observer.toolStarted(id, "web search");
}

function progress(payload: RpcRecord, observer: TurnObserver, outputs: Map<string, string>): void {
  const id = text(payload, "itemId");
  const delta = text(payload, "delta");
  if (!id || !delta) return;
  outputs.set(id, `${outputs.get(id) ?? ""}${delta}`);
  observer.toolProgress(id, delta);
}

function completed(item: RpcRecord, observer: TurnObserver, outputs: Map<string, string>): void {
  const id = text(item, "id");
  if (item.type === "commandExecution") {
    const aggregate = text(item, "aggregatedOutput");
    const previous = outputs.get(id) ?? "";
    if (aggregate && aggregate !== previous) observer.toolProgress(id, aggregate.startsWith(previous) ? aggregate.slice(previous.length) : aggregate);
    observer.toolFinished(id, item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0));
  } else if (item.type === "fileChange") {
    observer.toolStarted(id, "file changes");
    observer.toolProgress(id, (Array.isArray(item.changes) ? item.changes : []).map((entry) => {
      const change = record(entry);
      return [text(change, "kind"), text(change, "path")].filter(Boolean).join(" ");
    }).join(", "));
    observer.toolFinished(id, item.status === "failed");
  } else if (["mcpToolCall", "dynamicToolCall", "webSearch"].includes(String(item.type))) {
    observer.toolFinished(id, item.status === "failed" || item.success === false);
  }
}

function approvalFrom(name: string, payload: RpcRecord): ApprovalPrompt | null {
  const base = { itemId: text(payload, "itemId") || "approval", reason: text(payload, "reason") || undefined };
  if (name === "item/commandExecution/requestApproval") return { ...base, category: "command", command: text(payload, "command") || undefined, directory: text(payload, "cwd") || undefined };
  if (name === "item/fileChange/requestApproval") return { ...base, category: "files", root: text(payload, "grantRoot") || undefined };
  if (name === "item/permissions/requestApproval") return { ...base, category: "permissions", directory: text(payload, "cwd") || undefined };
  return null;
}

function compactPermissions(requested: RpcRecord): RpcRecord {
  const result: RpcRecord = {};
  if (requested.network) result.network = requested.network;
  if (requested.fileSystem) result.fileSystem = requested.fileSystem;
  return result;
}

function readTokens(value: RpcRecord): TokenCount {
  return { input: number(value.inputTokens), cached: number(value.cachedInputTokens), output: number(value.outputTokens) };
}

function readPlan(value: unknown): readonly { text: string; done: boolean }[] {
  return (Array.isArray(value) ? value : []).map((entry) => {
    const step = record(entry);
    return { text: text(step, "step") || "Step", done: step.status === "completed" };
  });
}

function readStoredThread(value: unknown): StoredThread | null {
  const item = record(value);
  const id = text(item, "id");
  if (!id) return null;
  return {
    id,
    title: text(item, "name") || text(item, "preview") || "Untitled",
    workspace: text(item, "cwd"),
    model: text(item, "model") || undefined,
    updatedAt: 1000 * number(item.updatedAt),
    archived: item.archived === true,
  };
}

function record(value: unknown): RpcRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RpcRecord : {};
}

function text(value: RpcRecord, key: string): string {
  return typeof value[key] === "string" ? value[key] as string : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
