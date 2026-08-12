import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export type WorkStatus = "todo" | "queued" | "running" | "waiting" | "done" | "cancelled";

export interface WorkItem {
  id: string;
  owner: string;
  title: string;
  prompt: string;
  status: WorkStatus;
  project?: string;
  projectLabel?: string;
  threadId?: string;
  dueAt?: number;
  queueOrder?: number;
  error?: string;
  createdAt: number;
  changedAt: number;
  finishedAt?: number;
}

export interface CapturedItem {
  id: string;
  owner: string;
  kind: string;
  body: string;
  sender?: string;
  sourceTime?: number;
  state: "new" | "task" | "memory" | "discarded";
  createdAt: number;
}

export interface Alarm {
  id: string;
  owner: string;
  label: string;
  nextAt: number;
  cadence: "once" | "daily" | "weekdays" | "weekly";
  mode: "notify" | "codex" | "digest-morning" | "digest-evening";
  prompt?: string;
  project?: string;
  enabled: boolean;
}

export interface MemoryNote {
  id: string;
  owner: string;
  body: string;
  tags?: string;
  createdAt: number;
  changedAt: number;
}

export type MemoryRole = "user" | "assistant" | "action";
export type MemoryKind = "message" | "voice" | "response" | "action" | "explicit" | "document";

export interface MemoryEvent {
  id: string;
  owner: string;
  namespace: "global" | "project";
  project?: string;
  role: MemoryRole;
  kind: MemoryKind;
  body: string;
  source?: string;
  createdAt: number;
  deletedAt?: number;
}

export interface MemoryEventUpsertResult {
  event: MemoryEvent;
  status: "created" | "updated" | "unchanged" | "forgotten";
}

export interface MemoryStatus {
  paused: boolean;
  active: number;
  deleted: number;
  global: number;
  project: number;
}

export type PersonalFactCategory =
  | "identity"
  | "location"
  | "education"
  | "work"
  | "project"
  | "interest"
  | "preference"
  | "value"
  | "relationship"
  | "health"
  | "goal"
  | "style"
  | "other";

export type PersonalFactStatus = "current" | "historical" | "uncertain" | "superseded";

export interface PersonalFact {
  id: string;
  owner: string;
  category: PersonalFactCategory;
  statement: string;
  subject: string;
  predicate: string;
  object: string;
  status: PersonalFactStatus;
  confidence: number;
  source?: string;
  evidenceMemoryId?: string;
  validFrom?: number;
  validTo?: number;
  observedAt: number;
  createdAt: number;
  changedAt: number;
}

export interface UpsertPersonalFactInput extends Omit<PersonalFact, "createdAt" | "changedAt"> {}

export type VoiceWritingMode = "transcript" | "diary" | "story";

export interface VoiceWritingSettings {
  context: string;
  owner: string;
  mode: VoiceWritingMode;
  storyTitle?: string;
  changedAt: number;
}

export interface SavedConversation {
  context: string;
  threadId?: string;
  workspace: string;
  model?: string;
  effort?: string;
  profileId: string;
  changedAt: number;
}

export interface SearchHit {
  type: "task" | "capture" | "memory";
  id: string;
  text: string;
  changedAt: number;
}

export interface SentBlogTopic {
  owner: string;
  sourceId: string;
  pillar: string;
  studyTitle: string;
  sourceUrl: string;
  markdown: string;
  sentAt: number;
}

export interface SelectedBlogTopic extends SentBlogTopic {
  selectedAt: number;
}

export class AssistantDatabase {
  private readonly sql: Database.Database;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new Database(file);
    this.sql.pragma("journal_mode = WAL");
    this.sql.pragma("foreign_keys = ON");
    this.install();
  }

  close(): void {
    this.sql.close();
  }

  saveConversation(value: Omit<SavedConversation, "changedAt">): SavedConversation {
    const row = { ...value, changedAt: Date.now() };
    this.sql.prepare(`INSERT INTO conversations(context, thread_id, workspace, model, effort, profile_id, changed_at)
      VALUES(@context,@threadId,@workspace,@model,@effort,@profileId,@changedAt)
      ON CONFLICT(context) DO UPDATE SET thread_id=excluded.thread_id, workspace=excluded.workspace,
      model=excluded.model, effort=excluded.effort, profile_id=excluded.profile_id, changed_at=excluded.changed_at`)
      .run(nullable({ ...row, threadId: row.threadId, model: row.model, effort: row.effort }));
    return row;
  }

  conversation(context: string): SavedConversation | undefined {
    return mapConversation(this.sql.prepare("SELECT * FROM conversations WHERE context=?").get(context));
  }

  createTask(input: Pick<WorkItem, "owner" | "title"> & Partial<Pick<WorkItem, "prompt" | "project" | "projectLabel" | "dueAt" | "status">>): WorkItem {
    const now = Date.now();
    const item: WorkItem = {
      id: randomUUID(), owner: input.owner, title: input.title.trim(), prompt: input.prompt?.trim() || input.title.trim(),
      status: input.status ?? "todo", project: input.project, projectLabel: input.projectLabel, dueAt: input.dueAt,
      createdAt: now, changedAt: now,
    };
    if (!item.title) throw new Error("Task title is required");
    this.sql.prepare(`INSERT INTO tasks(id,owner,title,prompt,status,project,project_label,due_at,created_at,changed_at)
      VALUES(@id,@owner,@title,@prompt,@status,@project,@projectLabel,@dueAt,@createdAt,@changedAt)`).run(nullable(item));
    return item;
  }

  task(id: string): WorkItem | undefined {
    return mapTask(this.sql.prepare("SELECT * FROM tasks WHERE id=?").get(id));
  }

  tasks(owner: string, statuses?: readonly WorkStatus[], limit = 50): WorkItem[] {
    const filters = statuses?.length ? ` AND status IN (${statuses.map(() => "?").join(",")})` : "";
    const rows = this.sql.prepare(`SELECT * FROM tasks WHERE owner=?${filters}
      ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
      COALESCE(due_at, 9223372036854775807), changed_at DESC LIMIT ?`)
      .all(owner, ...(statuses ?? []), limit);
    return rows.map(mapTask).filter(present);
  }

  tasksChangedSince(owner: string, since: number, limit = 100): WorkItem[] {
    return this.sql.prepare(`SELECT * FROM tasks WHERE owner=? AND (created_at>=? OR changed_at>=? OR COALESCE(finished_at,0)>=?)
      ORDER BY changed_at ASC LIMIT ?`).all(owner, since, since, since, limit).map(mapTask).filter(present);
  }

  tasksChangedBetween(owner: string, since: number, until: number, limit = 100): WorkItem[] {
    return this.sql.prepare(`SELECT * FROM tasks WHERE owner=?
      AND ((created_at>=? AND created_at<?) OR (changed_at>=? AND changed_at<?) OR (COALESCE(finished_at,0)>=? AND COALESCE(finished_at,0)<?))
      ORDER BY changed_at ASC LIMIT ?`).all(owner, since, until, since, until, since, until, limit).map(mapTask).filter(present);
  }

  updateTask(id: string, changes: Partial<Pick<WorkItem, "status" | "project" | "projectLabel" | "threadId" | "dueAt" | "error" | "finishedAt">>): WorkItem | undefined {
    const columns: Record<string, string> = {
      status: "status", project: "project", projectLabel: "project_label", threadId: "thread_id",
      dueAt: "due_at", error: "error", finishedAt: "finished_at",
    };
    const entries = Object.entries(changes).filter(([key]) => columns[key]);
    if (!entries.length) return this.task(id);
    const set = entries.map(([key]) => `${columns[key]}=@${key}`).join(",");
    this.sql.prepare(`UPDATE tasks SET ${set}, changed_at=@changedAt WHERE id=@id`).run(nullable({ id, changedAt: Date.now(), ...changes }));
    return this.task(id);
  }

  enqueue(id: string): WorkItem | undefined {
    const row = this.sql.prepare("SELECT COALESCE(MAX(queue_order),0)+1 AS next FROM tasks").get() as { next: number };
    this.sql.prepare("UPDATE tasks SET status='queued', queue_order=?, error=NULL, changed_at=? WHERE id=?").run(row.next, Date.now(), id);
    return this.task(id);
  }

  queued(): WorkItem | undefined {
    return mapTask(this.sql.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY queue_order, created_at LIMIT 1").get());
  }

  counts(owner: string): Record<WorkStatus, number> {
    const result: Record<WorkStatus, number> = { todo: 0, queued: 0, running: 0, waiting: 0, done: 0, cancelled: 0 };
    const rows = this.sql.prepare("SELECT status, COUNT(*) AS count FROM tasks WHERE owner=? GROUP BY status").all(owner) as Array<{ status: WorkStatus; count: number }>;
    for (const row of rows) result[row.status] = row.count;
    return result;
  }

  capture(input: Pick<CapturedItem, "owner" | "kind" | "body"> & Partial<Pick<CapturedItem, "sender" | "sourceTime" | "state">>): CapturedItem {
    const item: CapturedItem = {
      id: randomUUID(), owner: input.owner, kind: input.kind, body: input.body.trim(), sender: input.sender,
      sourceTime: input.sourceTime, state: input.state ?? "new", createdAt: Date.now(),
    };
    if (!item.body) throw new Error("Captured content is required");
    this.sql.prepare(`INSERT INTO captures(id,owner,kind,body,sender,source_time,state,created_at)
      VALUES(@id,@owner,@kind,@body,@sender,@sourceTime,@state,@createdAt)`).run(nullable(item));
    return item;
  }

  captures(owner: string, state: CapturedItem["state"] = "new", limit = 30): CapturedItem[] {
    return this.sql.prepare("SELECT * FROM captures WHERE owner=? AND state=? ORDER BY created_at DESC LIMIT ?")
      .all(owner, state, limit).map(mapCapture).filter(present);
  }

  resolveCapture(id: string, state: CapturedItem["state"]): void {
    this.sql.prepare("UPDATE captures SET state=? WHERE id=?").run(state, id);
  }

  remember(owner: string, body: string, tags?: string): MemoryNote {
    const now = Date.now();
    const note: MemoryNote = { id: randomUUID(), owner, body: body.trim(), tags, createdAt: now, changedAt: now };
    if (!note.body) throw new Error("Memory body is required");
    this.sql.prepare("INSERT INTO memories(id,owner,body,tags,created_at,changed_at) VALUES(@id,@owner,@body,@tags,@createdAt,@changedAt)")
      .run(nullable(note));
    return note;
  }

  memories(owner: string, limit = 30): MemoryNote[] {
    return this.sql.prepare("SELECT * FROM memories WHERE owner=? ORDER BY changed_at DESC LIMIT ?")
      .all(owner, limit).map(mapMemory).filter(present);
  }

  forget(id: string): boolean {
    return this.sql.prepare("DELETE FROM memories WHERE id=?").run(id).changes > 0;
  }

  recordMemoryEvent(input: Pick<MemoryEvent, "owner" | "namespace" | "role" | "kind" | "body"> &
    Partial<Pick<MemoryEvent, "project" | "source" | "createdAt">>): MemoryEvent {
    const event: MemoryEvent = {
      id: randomUUID(), owner: input.owner, namespace: input.namespace, project: input.project,
      role: input.role, kind: input.kind, body: input.body.trim(), source: input.source, createdAt: input.createdAt ?? Date.now(),
    };
    if (!event.body) throw new Error("Memory event body is required");
    this.sql.prepare(`INSERT INTO memory_events(id,owner,namespace,project,role,kind,body,source,created_at,deleted_at)
      VALUES(@id,@owner,@namespace,@project,@role,@kind,@body,@source,@createdAt,NULL)`).run(nullable(event));
    return event;
  }

  upsertMemoryEventBySource(input: Pick<MemoryEvent,
    "owner" | "namespace" | "role" | "kind" | "body" | "source" | "createdAt"> &
    Partial<Pick<MemoryEvent, "project">>): MemoryEventUpsertResult {
    const source = input.source?.trim();
    const body = input.body.trim();
    if (!source) throw new Error("Memory event source is required");
    if (!body) throw new Error("Memory event body is required");
    const existing = mapMemoryEvent(this.sql.prepare(
      "SELECT * FROM memory_events WHERE owner=? AND source=? ORDER BY created_at DESC LIMIT 1",
    ).get(input.owner, source));
    if (!existing) {
      return { event: this.recordMemoryEvent({ ...input, source, body }), status: "created" };
    }
    if (existing.deletedAt) return { event: existing, status: "forgotten" };
    const changed = existing.namespace !== input.namespace ||
      existing.project !== input.project ||
      existing.role !== input.role ||
      existing.kind !== input.kind ||
      existing.body !== body ||
      existing.createdAt !== input.createdAt;
    if (!changed) return { event: existing, status: "unchanged" };
    this.sql.prepare(`UPDATE memory_events SET namespace=@namespace,project=@project,role=@role,kind=@kind,
      body=@body,created_at=@createdAt WHERE id=@id`).run(nullable({
      id: existing.id,
      namespace: input.namespace,
      project: input.project,
      role: input.role,
      kind: input.kind,
      body,
      createdAt: input.createdAt,
    }));
    return { event: this.memoryEvent(existing.id)!, status: "updated" };
  }

  memoryEvent(id: string): MemoryEvent | undefined {
    return mapMemoryEvent(this.sql.prepare("SELECT * FROM memory_events WHERE id=?").get(id));
  }

  memoryEvents(owner: string, options: { includeDeleted?: boolean; limit?: number } = {}): MemoryEvent[] {
    const deleted = options.includeDeleted ? "" : " AND deleted_at IS NULL";
    return this.sql.prepare(`SELECT * FROM memory_events WHERE owner=?${deleted} ORDER BY created_at DESC LIMIT ?`)
      .all(owner, options.limit ?? 5000).map(mapMemoryEvent).filter(present);
  }

  reportExcludedMemoryEvents(): MemoryEvent[] {
    return this.sql.prepare(`SELECT * FROM memory_events WHERE deleted_at IS NULL AND
      (source LIKE 'telegram-forwarded-voice:%' OR source='forwarded-voice-batch' OR source='daily-summary')
      ORDER BY created_at`).all().map(mapMemoryEvent).filter(present);
  }

  forgetMemoryEvent(owner: string, id: string): MemoryEvent | undefined {
    const event = this.memoryEvent(id);
    if (!event || event.owner !== owner || event.deletedAt) return undefined;
    this.sql.prepare("UPDATE memory_events SET deleted_at=? WHERE id=? AND owner=?").run(Date.now(), id, owner);
    return this.memoryEvent(id);
  }

  memoryPaused(owner: string): boolean {
    const row = this.sql.prepare("SELECT paused FROM memory_settings WHERE owner=?").get(owner) as { paused?: number } | undefined;
    return Boolean(row?.paused);
  }

  setMemoryPaused(owner: string, paused: boolean): void {
    this.sql.prepare(`INSERT INTO memory_settings(owner,paused,changed_at) VALUES(?,?,?)
      ON CONFLICT(owner) DO UPDATE SET paused=excluded.paused,changed_at=excluded.changed_at`)
      .run(owner, paused ? 1 : 0, Date.now());
  }

  voiceWritingSettings(context: string, owner: string): VoiceWritingSettings {
    const row = this.sql.prepare("SELECT * FROM voice_writing_settings WHERE context=? AND owner=?").get(context, owner);
    return mapVoiceWritingSettings(row) ?? { context, owner, mode: "transcript", changedAt: 0 };
  }

  setVoiceWritingSettings(input: Pick<VoiceWritingSettings, "context" | "owner" | "mode"> &
    Partial<Pick<VoiceWritingSettings, "storyTitle">>): VoiceWritingSettings {
    const value: VoiceWritingSettings = {
      context: input.context,
      owner: input.owner,
      mode: input.mode,
      storyTitle: input.mode === "story" ? input.storyTitle?.trim() : undefined,
      changedAt: Date.now(),
    };
    if (value.mode === "story" && !value.storyTitle) throw new Error("Story title is required");
    this.sql.prepare(`INSERT INTO voice_writing_settings(context,owner,mode,story_title,changed_at)
      VALUES(@context,@owner,@mode,@storyTitle,@changedAt)
      ON CONFLICT(context) DO UPDATE SET owner=excluded.owner,mode=excluded.mode,
      story_title=excluded.story_title,changed_at=excluded.changed_at`).run(nullable(value));
    return value;
  }

  memoryStatus(owner: string): MemoryStatus {
    const rows = this.sql.prepare(`SELECT namespace, deleted_at IS NOT NULL AS deleted, COUNT(*) AS count
      FROM memory_events WHERE owner=? GROUP BY namespace, deleted`).all(owner) as Array<{ namespace: "global" | "project"; deleted: number; count: number }>;
    const result: MemoryStatus = { paused: this.memoryPaused(owner), active: 0, deleted: 0, global: 0, project: 0 };
    for (const row of rows) {
      if (row.deleted) result.deleted += row.count;
      else {
        result.active += row.count;
        result[row.namespace] += row.count;
      }
    }
    return result;
  }

  upsertPersonalFact(input: UpsertPersonalFactInput): PersonalFact {
    const existing = mapPersonalFact(this.sql.prepare("SELECT * FROM personal_facts WHERE id=?").get(input.id));
    if (existing && existing.owner !== input.owner) throw new Error("Personal fact belongs to another owner");
    const now = Date.now();
    const fact: PersonalFact = {
      ...input,
      id: input.id.trim(),
      owner: input.owner.trim(),
      category: input.category,
      statement: input.statement.trim(),
      subject: input.subject.trim(),
      predicate: input.predicate.trim(),
      object: input.object.trim(),
      confidence: Math.max(0, Math.min(1, input.confidence)),
      source: input.source?.trim() || undefined,
      evidenceMemoryId: input.evidenceMemoryId?.trim() || undefined,
      validFrom: input.validFrom,
      validTo: input.validTo,
      createdAt: existing?.createdAt ?? now,
      changedAt: now,
    };
    if (!fact.id || !fact.owner || !fact.statement || !fact.subject || !fact.predicate || !fact.object) {
      throw new Error("Personal fact id, owner, statement, subject, predicate and object are required");
    }
    if (fact.validFrom !== undefined && fact.validTo !== undefined && fact.validTo < fact.validFrom) {
      throw new Error("Personal fact validTo cannot precede validFrom");
    }
    this.sql.prepare(`INSERT INTO personal_facts(
      id,owner,category,statement,subject,predicate,object_value,status,confidence,source,evidence_memory_id,
      valid_from,valid_to,observed_at,created_at,changed_at
    ) VALUES(
      @id,@owner,@category,@statement,@subject,@predicate,@object,@status,@confidence,@source,@evidenceMemoryId,
      @validFrom,@validTo,@observedAt,@createdAt,@changedAt
    ) ON CONFLICT(id) DO UPDATE SET
      category=excluded.category,statement=excluded.statement,subject=excluded.subject,predicate=excluded.predicate,
      object_value=excluded.object_value,status=excluded.status,confidence=excluded.confidence,source=excluded.source,
      evidence_memory_id=excluded.evidence_memory_id,valid_from=excluded.valid_from,valid_to=excluded.valid_to,
      observed_at=excluded.observed_at,changed_at=excluded.changed_at`).run(nullable(fact));
    return this.personalFact(fact.id)!;
  }

  personalFact(id: string): PersonalFact | undefined {
    return mapPersonalFact(this.sql.prepare("SELECT * FROM personal_facts WHERE id=?").get(id));
  }

  personalFacts(owner: string, options: { includeSuperseded?: boolean; limit?: number } = {}): PersonalFact[] {
    const superseded = options.includeSuperseded ? "" : " AND status<>'superseded'";
    return this.sql.prepare(`SELECT * FROM personal_facts WHERE owner=?${superseded}
      ORDER BY CASE status WHEN 'current' THEN 0 WHEN 'historical' THEN 1 WHEN 'uncertain' THEN 2 ELSE 3 END,
      confidence DESC, observed_at DESC LIMIT ?`).all(owner, options.limit ?? 200).map(mapPersonalFact).filter(present);
  }

  createAlarm(input: Pick<Alarm, "owner" | "label" | "nextAt"> & Partial<Pick<Alarm, "cadence" | "mode" | "prompt" | "project">>): Alarm {
    const alarm: Alarm = {
      id: randomUUID(), owner: input.owner, label: input.label.trim(), nextAt: input.nextAt,
      cadence: input.cadence ?? "once", mode: input.mode ?? "notify", prompt: input.prompt,
      project: input.project, enabled: true,
    };
    this.sql.prepare(`INSERT INTO alarms(id,owner,label,next_at,cadence,mode,prompt,project,enabled)
      VALUES(@id,@owner,@label,@nextAt,@cadence,@mode,@prompt,@project,1)`).run(nullable(alarm));
    return alarm;
  }

  alarms(owner: string, enabledOnly = true): Alarm[] {
    return this.sql.prepare(`SELECT * FROM alarms WHERE owner=?${enabledOnly ? " AND enabled=1" : ""} ORDER BY next_at`)
      .all(owner).map(mapAlarm).filter(present);
  }

  dueAlarms(now = Date.now()): Alarm[] {
    return this.sql.prepare("SELECT * FROM alarms WHERE enabled=1 AND next_at<=? ORDER BY next_at")
      .all(now).map(mapAlarm).filter(present);
  }

  advanceAlarm(id: string, now = Date.now()): void {
    const alarm = mapAlarm(this.sql.prepare("SELECT * FROM alarms WHERE id=?").get(id));
    if (!alarm) return;
    const next = following(alarm.nextAt, alarm.cadence, now);
    this.sql.prepare("UPDATE alarms SET enabled=?, next_at=? WHERE id=?").run(next ? 1 : 0, next ?? alarm.nextAt, id);
  }

  deleteAlarm(id: string): boolean {
    return this.sql.prepare("DELETE FROM alarms WHERE id=?").run(id).changes > 0;
  }

  recordBlogTopic(input: SentBlogTopic): void {
    this.sql.prepare(`INSERT INTO sent_blog_topics(owner,source_id,pillar,study_title,source_url,markdown,sent_at)
      VALUES(@owner,@sourceId,@pillar,@studyTitle,@sourceUrl,@markdown,@sentAt)
      ON CONFLICT(owner,source_id) DO UPDATE SET pillar=excluded.pillar,study_title=excluded.study_title,
      source_url=excluded.source_url,markdown=excluded.markdown,sent_at=excluded.sent_at`).run(input);
  }

  sentBlogTopicSourceIds(owner: string, since: number): string[] {
    return (this.sql.prepare("SELECT source_id FROM sent_blog_topics WHERE owner=? AND sent_at>=? ORDER BY sent_at DESC")
      .all(owner, since) as Array<{ source_id: string }>).map((row) => row.source_id);
  }

  blogTopic(owner: string, sourceId: string): SentBlogTopic | undefined {
    return mapSentBlogTopic(this.sql.prepare("SELECT * FROM sent_blog_topics WHERE owner=? AND source_id=?").get(owner, sourceId));
  }

  selectBlogTopic(owner: string, sourceId: string, selectedAt = Date.now()): SelectedBlogTopic {
    const topic = this.blogTopic(owner, sourceId);
    if (!topic) throw new Error("Blog topic not found");
    this.sql.prepare(`INSERT INTO selected_blog_topics(owner,source_id,selected_at) VALUES(?,?,?)
      ON CONFLICT(owner) DO UPDATE SET source_id=excluded.source_id,selected_at=excluded.selected_at`)
      .run(owner, sourceId, selectedAt);
    return { ...topic, selectedAt };
  }

  selectedBlogTopic(owner: string): SelectedBlogTopic | undefined {
    const row = this.sql.prepare(`SELECT t.*,s.selected_at FROM selected_blog_topics s
      JOIN sent_blog_topics t ON t.owner=s.owner AND t.source_id=s.source_id WHERE s.owner=?`).get(owner);
    const topic = mapSentBlogTopic(row);
    const record = object(row);
    const selectedAt = record ? Number(record.selected_at) : Number.NaN;
    return topic && Number.isFinite(selectedAt) ? { ...topic, selectedAt } : undefined;
  }

  alignDailyDigests(summaryAt: number, morningAt: number, now = Date.now()): number {
    const summary = this.sql.prepare(`UPDATE alarms SET label='Итог за вчера',
      next_at=CASE WHEN next_at<=? THEN next_at ELSE ? END
      WHERE enabled=1 AND cadence='daily' AND mode='digest-evening'`).run(now, summaryAt).changes;
    const morning = this.sql.prepare(`UPDATE alarms SET label='Утренний дайджест',
      next_at=CASE WHEN next_at<=? THEN next_at ELSE ? END
      WHERE enabled=1 AND cadence='daily' AND mode='digest-morning'`).run(now, morningAt).changes;
    return summary + morning;
  }

  search(owner: string, query: string, limit = 30): SearchHit[] {
    const needle = query.trim().toLocaleLowerCase("ru-RU");
    if (!needle) return [];
    const taskHits = this.tasks(owner, undefined, 500).map<SearchHit>((item) => ({ type: "task", id: item.id, text: `${item.title}\n${item.prompt}`, changedAt: item.changedAt }));
    const captureHits = (["new", "task", "memory", "discarded"] as const).flatMap((state) => this.captures(owner, state, 500))
      .map<SearchHit>((item) => ({ type: "capture", id: item.id, text: item.body, changedAt: item.createdAt }));
    const memoryHits = this.memories(owner, 500).map<SearchHit>((item) => ({ type: "memory", id: item.id, text: item.body, changedAt: item.changedAt }));
    return [...taskHits, ...captureHits, ...memoryHits]
      .filter((item) => item.text.toLocaleLowerCase("ru-RU").includes(needle))
      .sort((left, right) => right.changedAt - left.changedAt).slice(0, limit);
  }

  private install(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversations(context TEXT PRIMARY KEY, thread_id TEXT, workspace TEXT NOT NULL, model TEXT, effort TEXT, profile_id TEXT NOT NULL, changed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, project TEXT, project_label TEXT, thread_id TEXT, due_at INTEGER, queue_order INTEGER, error TEXT, created_at INTEGER NOT NULL, changed_at INTEGER NOT NULL, finished_at INTEGER);
      CREATE INDEX IF NOT EXISTS task_owner_state ON tasks(owner,status,changed_at);
      CREATE TABLE IF NOT EXISTS captures(id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, sender TEXT, source_time INTEGER, state TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS capture_owner_state ON captures(owner,state,created_at);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL, tags TEXT, created_at INTEGER NOT NULL, changed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_events(id TEXT PRIMARY KEY, owner TEXT NOT NULL, namespace TEXT NOT NULL, project TEXT, role TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, source TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE INDEX IF NOT EXISTS memory_event_owner_scope ON memory_events(owner,namespace,project,created_at);
      CREATE TABLE IF NOT EXISTS memory_settings(owner TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0, changed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_facts(
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        category TEXT NOT NULL,
        statement TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object_value TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT,
        evidence_memory_id TEXT,
        valid_from INTEGER,
        valid_to INTEGER,
        observed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        changed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS personal_fact_owner_status ON personal_facts(owner,status,category,changed_at);
      CREATE TABLE IF NOT EXISTS voice_writing_settings(context TEXT PRIMARY KEY, owner TEXT NOT NULL, mode TEXT NOT NULL, story_title TEXT, changed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS alarms(id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL, next_at INTEGER NOT NULL, cadence TEXT NOT NULL, mode TEXT NOT NULL, prompt TEXT, project TEXT, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sent_blog_topics(
        owner TEXT NOT NULL,
        source_id TEXT NOT NULL,
        pillar TEXT NOT NULL,
        study_title TEXT NOT NULL,
        source_url TEXT NOT NULL,
        markdown TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        PRIMARY KEY(owner,source_id)
      );
      CREATE INDEX IF NOT EXISTS sent_blog_topic_owner_date ON sent_blog_topics(owner,sent_at);
      CREATE TABLE IF NOT EXISTS selected_blog_topics(
        owner TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        selected_at INTEGER NOT NULL
      );
    `);
  }
}

function following(previous: number, cadence: Alarm["cadence"], now: number): number | undefined {
  if (cadence === "once") return undefined;
  const next = new Date(previous);
  do {
    if (cadence === "daily") next.setDate(next.getDate() + 1);
    if (cadence === "weekly") next.setDate(next.getDate() + 7);
    if (cadence === "weekdays") {
      do next.setDate(next.getDate() + 1); while ([0, 6].includes(next.getDay()));
    }
  } while (next.getTime() <= now);
  return next.getTime();
}

function nullable<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === undefined ? null : item]));
}

function mapTask(row: unknown): WorkItem | undefined {
  const r = object(row); if (!r) return undefined;
  return { id: str(r.id), owner: str(r.owner), title: str(r.title), prompt: str(r.prompt), status: str(r.status) as WorkStatus,
    project: maybe(r.project), projectLabel: maybe(r.project_label), threadId: maybe(r.thread_id), dueAt: num(r.due_at),
    queueOrder: num(r.queue_order), error: maybe(r.error), createdAt: Number(r.created_at), changedAt: Number(r.changed_at), finishedAt: num(r.finished_at) };
}

function mapCapture(row: unknown): CapturedItem | undefined {
  const r = object(row); if (!r) return undefined;
  return { id: str(r.id), owner: str(r.owner), kind: str(r.kind), body: str(r.body), sender: maybe(r.sender),
    sourceTime: num(r.source_time), state: str(r.state) as CapturedItem["state"], createdAt: Number(r.created_at) };
}

function mapVoiceWritingSettings(row: unknown): VoiceWritingSettings | undefined {
  const r = object(row); if (!r) return undefined;
  const mode = str(r.mode);
  if (mode !== "transcript" && mode !== "diary" && mode !== "story") return undefined;
  return { context: str(r.context), owner: str(r.owner), mode, storyTitle: maybe(r.story_title), changedAt: Number(r.changed_at) };
}

function mapMemory(row: unknown): MemoryNote | undefined {
  const r = object(row); if (!r) return undefined;
  return { id: str(r.id), owner: str(r.owner), body: str(r.body), tags: maybe(r.tags), createdAt: Number(r.created_at), changedAt: Number(r.changed_at) };
}

function mapMemoryEvent(row: unknown): MemoryEvent | undefined {
  const r = object(row); if (!r) return undefined;
  return {
    id: str(r.id), owner: str(r.owner), namespace: str(r.namespace) as MemoryEvent["namespace"], project: maybe(r.project),
    role: str(r.role) as MemoryRole, kind: str(r.kind) as MemoryKind, body: str(r.body), source: maybe(r.source),
    createdAt: Number(r.created_at), deletedAt: num(r.deleted_at),
  };
}

function mapSentBlogTopic(row: unknown): SentBlogTopic | undefined {
  const r = object(row); if (!r) return undefined;
  return {
    owner: str(r.owner),
    sourceId: str(r.source_id),
    pillar: str(r.pillar),
    studyTitle: str(r.study_title),
    sourceUrl: str(r.source_url),
    markdown: str(r.markdown),
    sentAt: Number(r.sent_at),
  };
}

function mapPersonalFact(row: unknown): PersonalFact | undefined {
  const r = object(row); if (!r) return undefined;
  return {
    id: str(r.id),
    owner: str(r.owner),
    category: str(r.category) as PersonalFactCategory,
    statement: str(r.statement),
    subject: str(r.subject),
    predicate: str(r.predicate),
    object: str(r.object_value),
    status: str(r.status) as PersonalFactStatus,
    confidence: Number(r.confidence),
    source: maybe(r.source),
    evidenceMemoryId: maybe(r.evidence_memory_id),
    validFrom: num(r.valid_from),
    validTo: num(r.valid_to),
    observedAt: Number(r.observed_at),
    createdAt: Number(r.created_at),
    changedAt: Number(r.changed_at),
  };
}

function mapAlarm(row: unknown): Alarm | undefined {
  const r = object(row); if (!r) return undefined;
  return { id: str(r.id), owner: str(r.owner), label: str(r.label), nextAt: Number(r.next_at), cadence: str(r.cadence) as Alarm["cadence"],
    mode: str(r.mode) as Alarm["mode"], prompt: maybe(r.prompt), project: maybe(r.project), enabled: Boolean(r.enabled) };
}

function mapConversation(row: unknown): SavedConversation | undefined {
  const r = object(row); if (!r) return undefined;
  return { context: str(r.context), threadId: maybe(r.thread_id), workspace: str(r.workspace), model: maybe(r.model), effort: maybe(r.effort), profileId: str(r.profile_id), changedAt: Number(r.changed_at) };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}
function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function maybe(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function num(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
function present<T>(value: T | undefined): value is T { return value !== undefined; }
