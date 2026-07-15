import { InlineKeyboard } from "grammy";

export const TELEGRAM_COPY_TEXT_LIMIT = 256;

export interface TelegramCopyPresentation {
  body: string;
  parseMode?: "HTML";
  keyboard?: InlineKeyboard;
}

export function transcriptionCopyPresentation(text: string): TelegramCopyPresentation {
  if (text.length <= TELEGRAM_COPY_TEXT_LIMIT) {
    return { body: text, keyboard: new InlineKeyboard().copyText("📋 Скопировать", text) };
  }
  return { body: `<pre>${escapeHtml(text)}</pre>`, parseMode: "HTML" };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
