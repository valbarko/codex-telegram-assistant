import type { AppConfiguration } from "./configuration.js";
import { CodexHub, type ApprovalChoice, type TurnObserver, type UserInputAnswers } from "./codex-engine.js";

export const FORWARDED_VOICE_WAIT_MS = 45_000;
export const FORWARDED_VOICE_SOURCE_GAP_MS = 10 * 60_000;

export interface ForwardedVoiceFragment {
  id: string;
  sender: string;
  senderKey: string;
  sentAt: number;
  durationSeconds: number;
  transcript: string;
  progressMessageId: number;
  chatId: string | number;
  messageThreadId?: number;
}

export interface ForwardedVoiceBatch {
  key: string;
  fragments: ForwardedVoiceFragment[];
}

interface PendingBatch extends ForwardedVoiceBatch {
  timer: NodeJS.Timeout;
}

export class ForwardedVoiceBatcher {
  private readonly pending = new Map<string, PendingBatch>();

  constructor(
    private readonly flush: (batch: ForwardedVoiceBatch) => void,
    private readonly waitMs = FORWARDED_VOICE_WAIT_MS,
    private readonly sourceGapMs = FORWARDED_VOICE_SOURCE_GAP_MS,
  ) {}

  add(key: string, fragment: ForwardedVoiceFragment): number {
    const current = this.pending.get(key);
    if (current && !canJoinForwardedVoiceBatch(current.fragments, fragment, this.sourceGapMs)) {
      this.deliver(key, current);
    }
    const active = this.pending.get(key);
    const fragments = [...(active?.fragments ?? []), fragment].sort(compareFragments);
    if (active) clearTimeout(active.timer);
    const batch: PendingBatch = { key, fragments, timer: setTimeout(() => this.deliver(key, batch), this.waitMs) };
    this.pending.set(key, batch);
    return fragments.length;
  }

  stop(): void {
    for (const batch of this.pending.values()) clearTimeout(batch.timer);
    this.pending.clear();
  }

  private deliver(key: string, batch: PendingBatch): void {
    if (this.pending.get(key) === batch) this.pending.delete(key);
    clearTimeout(batch.timer);
    this.flush({ key: batch.key, fragments: [...batch.fragments].sort(compareFragments) });
  }
}

export function canJoinForwardedVoiceBatch(fragments: readonly ForwardedVoiceFragment[], candidate: ForwardedVoiceFragment,
  gapMs = FORWARDED_VOICE_SOURCE_GAP_MS): boolean {
  const ordered = [...fragments, candidate].sort(compareFragments);
  return ordered.every((fragment, index) => index === 0 || fragment.sentAt - ordered[index - 1]!.sentAt <= gapMs);
}

export class ForwardedVoiceEditor {
  constructor(private readonly configuration: AppConfiguration, private readonly hub: CodexHub) {}

  async edit(scope: string, fragments: readonly ForwardedVoiceFragment[]): Promise<string> {
    const profileId = this.configuration.profiles.find((profile) => profile.id === "readonly")?.id
      ?? this.configuration.defaultProfile;
    const conversation = await this.hub.conversation(`forwarded-voice-editor:${scope}`, {
      workspace: this.configuration.dataDirectory,
      model: this.configuration.defaultModel,
      profileId,
    });
    const observer = new TextObserver();
    await conversation.run(forwardedVoicePrompt(fragments), observer);
    const markdown = cleanMarkdown(observer.content());
    if (!markdown) throw new Error("Codex вернул пустую объединённую расшифровку");
    return markdown;
  }
}

export function forwardedVoicePrompt(fragments: readonly ForwardedVoiceFragment[]): string {
  const source = [...fragments].sort(compareFragments).map((fragment, index) => [
    `ФРАГМЕНТ ${index + 1} · ${formatTime(fragment.sentAt)}`,
    fragment.transcript,
  ].join("\n")).join("\n\n---\n\n");
  return [
    "Ты редактор последовательных расшифровок пересланных голосовых сообщений одного человека.",
    "Определи смысловую связность. Если все фрагменты об одной теме — объедини их в один цельный текст. Если тема меняется — раздели текст короткими Markdown-заголовками.",
    "Исправь пунктуацию, орфографию и только очевидные ошибки распознавания. Удали слова-паразиты и технические повторы, но не сокращай факты, имена, числа, решения и формулировки говорящего.",
    "Разбей результат на естественные абзацы. Выдели через **жирный Markdown** только несколько действительно важных мыслей.",
    "Не добавляй резюме, комментарии редактора, сведения об отправителе или времени. Не используй инструменты. Верни только готовый Markdown.",
    source,
  ].join("\n\n");
}

export function forwardedVoiceHeading(fragments: readonly ForwardedVoiceFragment[]): string {
  const ordered = [...fragments].sort(compareFragments);
  const first = ordered[0];
  const last = ordered.at(-1);
  if (!first || !last) return "Пересланные голосовые";
  const count = ordered.length === 1 ? "1 голосовое" : `${ordered.length} голосовых`;
  const duration = formatDuration(ordered.reduce((sum, fragment) => sum + fragment.durationSeconds, 0));
  const range = first.sentAt === last.sentAt ? formatTime(first.sentAt) : `${formatTime(first.sentAt)}–${formatTime(last.sentAt)}`;
  return [`## ${first.sender}`, `${count} · ${range}`, duration].filter(Boolean).join("\n\n");
}

function compareFragments(left: ForwardedVoiceFragment, right: ForwardedVoiceFragment): number {
  return left.sentAt - right.sentAt || left.id.localeCompare(right.id);
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(value));
}

function formatDuration(seconds: number): string | undefined {
  if (!seconds) return undefined;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `Общая длительность: ${[minutes ? `${minutes} мин` : "", rest ? `${rest} сек` : ""].filter(Boolean).join(" ")}`;
}

function cleanMarkdown(value: string): string {
  return value.trim().replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```$/, "").trim();
}

class TextObserver implements TurnObserver {
  private value = "";
  text(delta: string): void { this.value += delta; }
  toolStarted(): void {}
  toolProgress(): void {}
  toolFinished(): void {}
  approval(): Promise<ApprovalChoice> { return Promise.resolve("decline"); }
  userInput(): Promise<UserInputAnswers> { return Promise.resolve({}); }
  content(): string { return this.value; }
}
