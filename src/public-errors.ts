export type PublicErrorKind =
  | "request"
  | "scheduled-task"
  | "forwarded-voice"
  | "writing"
  | "text-formatting"
  | "media-summary"
  | "calendar-read"
  | "calendar-create"
  | "mail-draft"
  | "codex-open"
  | "health";

const PUBLIC_ERRORS: Record<PublicErrorKind, string> = {
  request: "Не удалось выполнить запрос. Попробуйте ещё раз.",
  "scheduled-task": "Не удалось выполнить задачу. Она оставлена в ожидании.",
  "forwarded-voice": "Не удалось обработать пересланные голосовые. Попробуйте отправить их ещё раз.",
  writing: "Не удалось подготовить текст. Исходный текст сохранён.",
  "text-formatting": "Не удалось оформить текст. Попробуйте отправить его ещё раз.",
  "media-summary": "Не удалось подготовить конспект. Попробуйте ещё раз.",
  "calendar-read": "Не удалось прочитать календарь. Проверьте доступ к календарю на Mac.",
  "calendar-create": "Не удалось создать событие. Проверьте доступ к календарю на Mac.",
  "mail-draft": "Не удалось создать черновик. Проверьте доступ к Apple Mail на Mac.",
  "codex-open": "Не удалось открыть Codex на Mac. Попробуйте ещё раз.",
  health: "Codex сейчас недоступен. Подробности записаны в журнал.",
};

export function publicErrorMessage(kind: PublicErrorKind = "request"): string {
  return PUBLIC_ERRORS[kind];
}

export function logInternalError(context: string, error: unknown): void {
  console.error(context, error);
}
