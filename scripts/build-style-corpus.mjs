import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const sourceRoot = path.join(root, ".private", "style-source");
const outputRoot = path.join(root, ".private", "style-corpus");

const sources = [
  {
    id: "barko-pro-zhizn",
    kind: "personal",
    weight: 1,
    file: path.join(sourceRoot, "barko-pro-zhizn", "result.json"),
  },
  {
    id: "v-svoem-tele",
    kind: "expert",
    weight: 0.75,
    file: path.join(sourceRoot, "v-svoem-tele", "result.json"),
  },
];

function messageText(message) {
  const value = message.text ?? "";
  if (typeof value === "string") return value;
  return value.map((part) => typeof part === "string" ? part : (part.text ?? "")).join("");
}

function normalize(value) {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function cleanForCorpus(value) {
  const removable = [
    /^#новости_туризма(?:\s*\|.*)?$/iu,
    /^#дайджест_новостей(?:\s*\|.*)?$/iu,
    /^Клуб путешествий Валентина Барко$/iu,
    /^(?:https?:\/\/\S+|@\w+)$/iu,
  ];
  return value
    .normalize("NFC")
    .split(/\r?\n/u)
    .filter((line) => !removable.some((pattern) => pattern.test(line.trim())))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function exclusionReason(source, message, text) {
  const lower = text.toLowerCase();
  if (message.type !== "message") return "service";
  if (!text.trim()) return "empty";
  if (message.forwarded_from || message.forward_from) return "forwarded";
  if (source.id === "v-svoem-tele" && !["user777547770", "channel2359399843"].includes(message.from_id)) {
    return "other_author";
  }
  if (source.id === "barko-pro-zhizn" && (
    lower.includes("#новости_туризма")
    || lower.includes("#дайджест_новостей")
    || /^\s*(?:дайджест.{0,35}новост|новости путешествий за неделю)/iu.test(text)
  )) return "news";
  if (text.includes("ОГЛАВЛЕНИЕ КАНАЛА:") || (text.includes("Подробнее обо мне") && text.includes("Как я работаю"))) {
    return "navigation";
  }
  const meaningful = text
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/@\w+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  if (meaningful.length < 30) return "too_short";
  return undefined;
}

function reactionCount(message) {
  return (message.reactions ?? []).reduce((total, reaction) => total + Number(reaction.count ?? 0), 0);
}

function tagsFor(source, text) {
  const lower = text.toLowerCase();
  const tags = new Set([source.kind]);
  if (text.length < 280) tags.add("micro");
  else if (text.length < 700) tags.add("short");
  else if (text.length < 1800) tags.add("post");
  else tags.add("longform");

  if (/😂|🤣|😁|😅|😆|\b(?:смеюсь|смешн|шут|ха-?ха|божемой|ржу)\b/iu.test(text)) tags.add("humor");
  if (/\b(?:я|мне|меня|мой|моя|моё|мы|нам|нас)\b/iu.test(text)) tags.add("first-person");
  if (/\b(?:вы|вам|вас|ваш|думаете|помните)\b/iu.test(text)) tags.add("reader-dialogue");
  if (/^(?:[-—➖•]|\d+[.)]|[✅✔️])/mu.test(text)) tags.add("list");
  if (/\b(?:цена|стоимость|записаться|мест осталось|старт продаж|скидк|расписание|анонс)\b/iu.test(text)) tags.add("announcement");
  if (/\b(?:путешеств|тур|отел|самол[её]т|аэропорт|страна|город|маршрут|поездк)\w*/iu.test(text)) tags.add("travel");
  if (/\b(?:трениров|питани|калори|белок|мышц|похуд|фитнес|психолог|здоров)\w*/iu.test(text)) tags.add("fitness");
  if (text.length >= 900 && tags.has("first-person") && !tags.has("list")) tags.add("essay");
  return [...tags];
}

function styleWeight(source, tags) {
  let weight = source.weight;
  if (tags.includes("humor") || tags.includes("essay")) weight += 0.15;
  if (tags.includes("announcement")) weight -= 0.2;
  return Math.max(0.4, Number(weight.toFixed(2)));
}

function markdown(post) {
  return [
    "---",
    `style_source: ${post.source}`,
    `post_id: ${post.id}`,
    `date: ${post.date}`,
    `weight: ${post.weight}`,
    `reactions: ${post.reactions}`,
    `tags: [${post.tags.join(", ")}]`,
    "---",
    "",
    post.text,
    "",
  ].join("\n");
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "posts"), { recursive: true });

const accepted = [];
const excluded = [];
const counts = {};
const seen = new Set();

for (const source of sources) {
  const data = JSON.parse(await readFile(source.file, "utf8"));
  counts[source.id] = { total: data.messages.length, accepted: 0, excluded: {} };
  const destination = path.join(outputRoot, "posts", source.id);
  await mkdir(destination, { recursive: true });

  for (const message of data.messages) {
    const originalText = messageText(message).trim();
    let reason = exclusionReason(source, message, originalText);
    const text = cleanForCorpus(originalText);
    const hash = createHash("sha256").update(normalize(text)).digest("hex");
    if (!reason && seen.has(hash)) reason = "duplicate";

    if (reason) {
      counts[source.id].excluded[reason] = (counts[source.id].excluded[reason] ?? 0) + 1;
      excluded.push({ source: source.id, id: message.id, date: message.date, reason, text: originalText });
      continue;
    }

    seen.add(hash);
    const tags = tagsFor(source, text);
    const post = {
      source: source.id,
      channel: data.name,
      id: message.id,
      date: message.date,
      reactions: reactionCount(message),
      tags,
      weight: styleWeight(source, tags),
      text,
      original_text: originalText,
    };
    const file = path.join(destination, `${String(message.id).padStart(6, "0")}.md`);
    await writeFile(file, markdown(post), "utf8");
    accepted.push({ ...post, file: path.relative(root, file) });
    counts[source.id].accepted += 1;
  }
}

await writeFile(path.join(outputRoot, "accepted.jsonl"), `${accepted.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
await writeFile(path.join(outputRoot, "excluded.jsonl"), `${excluded.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify({
  version: 1,
  generated_at: new Date().toISOString(),
  collection: "cta_style_valentin",
  accepted: accepted.length,
  excluded: excluded.length,
  counts,
}, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ accepted: accepted.length, excluded: excluded.length, counts }, null, 2));
