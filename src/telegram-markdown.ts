export interface TelegramMarkdownChunk {
  html: string;
  plain: string;
}

interface TelegramSendApi {
  sendMessage(chatId: string | number, text: string, options?: { parse_mode?: "HTML" }): Promise<unknown>;
}

export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.trim().split("\n");
  const result: string[] = [];
  let code: string[] | undefined;
  let language = "";
  for (const line of lines) {
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      if (code) {
        const className = language ? ` class="language-${escapeHtml(language)}"` : "";
        result.push(`<pre><code${className}>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = undefined; language = "";
      } else {
        code = []; language = fence[1] ?? "";
      }
      continue;
    }
    if (code) { code.push(line); continue; }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { result.push(`<b>${inlineHtml(heading[1]!)}</b>`); continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { result.push(`<blockquote>${inlineHtml(quote[1]!)}</blockquote>`); continue; }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) { result.push(`• ${inlineHtml(bullet[1]!)}`); continue; }
    result.push(inlineHtml(line));
  }
  if (code) result.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  return result.join("\n");
}

export function renderTelegramMarkdown(markdown: string, limit = 3950): TelegramMarkdownChunk {
  const plain = markdown.slice(0, limit);
  return { html: truncateTelegramHtml(markdownToTelegramHtml(markdown), limit), plain };
}

export function telegramMarkdownChunks(markdown: string, limit = 3900): TelegramMarkdownChunk[] {
  const paragraphs = markdown.trim().split(/\n{2,}/);
  const raw: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (markdownToTelegramHtml(candidate).length <= limit) { current = candidate; continue; }
    if (current) raw.push(current);
    if (markdownToTelegramHtml(paragraph).length <= limit) { current = paragraph; continue; }
    const pieces = splitLongText(paragraph, Math.max(500, limit - 300));
    raw.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? "";
  }
  if (current) raw.push(current);
  return raw.map((plain) => ({ html: truncateTelegramHtml(markdownToTelegramHtml(plain), limit), plain: plain.slice(0, limit) }));
}

export async function sendTelegramMarkdown(api: TelegramSendApi, chatId: string | number, markdown: string,
  limit = 3900): Promise<void> {
  for (const chunk of telegramMarkdownChunks(markdown, limit)) {
    try {
      await api.sendMessage(chatId, chunk.html, { parse_mode: "HTML" });
    } catch {
      await api.sendMessage(chatId, chunk.plain);
    }
  }
}

export function truncateTelegramHtml(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const tokens = value.match(/<[^>]+>|[^<]+/g) ?? [];
  const stack: string[] = [];
  let output = "";
  const closings = (): string => [...stack].reverse().map((tag) => `</${tag}>`).join("");
  for (const token of tokens) {
    const closing = token.match(/^<\/(b|i|s|code|pre|blockquote|a)>$/);
    if (closing) {
      const next = stack.lastIndexOf(closing[1]!);
      const remaining = next >= 0 ? stack.filter((_tag, index) => index !== next) : stack;
      const remainingClosings = [...remaining].reverse().map((tag) => `</${tag}>`).join("");
      if (output.length + token.length + remainingClosings.length > limit) break;
      if (next >= 0) stack.splice(next, 1);
      output += token;
      continue;
    }
    const opening = token.match(/^<(b|i|s|code|pre|blockquote|a)(?:\s[^>]*)?>$/);
    if (opening) {
      const prospective = `</${opening[1]}>`;
      if (output.length + token.length + closings().length + prospective.length > limit) break;
      output += token; stack.push(opening[1]!);
      continue;
    }
    const available = limit - output.length - closings().length;
    if (available <= 0) break;
    let piece = token.slice(0, available);
    if (piece.length < token.length) piece = piece.replace(/&[^;]*$/, "");
    output += piece;
    if (piece.length < token.length) break;
  }
  return output + closings();
}

function inlineHtml(value: string): string {
  const parts = value.split(/(`[^`\n]+`)/g);
  return parts.map((part) => {
    if (part.startsWith("`") && part.endsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    let escaped = escapeHtml(part);
    escaped = escaped.replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => `<a href="${escapeHtml(url)}">${label}</a>`);
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    escaped = escaped.replace(/~~(.+?)~~/g, "<s>$1</s>");
    escaped = escaped.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
    return escaped;
  }).join("");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function splitLongText(value: string, limit: number): string[] {
  const result: string[] = [];
  let rest = value;
  while (rest.length > limit) {
    const newline = rest.lastIndexOf("\n", limit);
    const space = rest.lastIndexOf(" ", limit);
    const cut = newline > limit / 2 ? newline : space > limit / 2 ? space : limit;
    result.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart();
  }
  if (rest) result.push(rest);
  return result;
}
