import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { editorPrompt, markdownToNotesHtml, parseSpokenVoiceCommand, VoiceWritingArchive } from "../src/voice-writing.js";

describe("voice writing", () => {
  let folder: string;

  beforeEach(async () => { folder = await mkdtemp(path.join(os.tmpdir(), "cta-writing-")); });
  afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

  it("keeps one monthly diary file and groups entries under one date", async () => {
    const archive = new VoiceWritingArchive(folder);
    const morning = Date.parse("2026-07-12T07:35:00Z");
    const evening = Date.parse("2026-07-12T18:10:00Z");
    const first = await archive.save("diary", "Первая **важная мысль**.", "сырой текст один", morning);
    await archive.save("diary", "Вторая запись.", "сырой текст два", evening);

    const content = await readFile(first.polishedPath, "utf8");
    expect(content.match(/## 12 июля/g)).toHaveLength(1);
    expect(content).toContain("### 10:35");
    expect(content).toContain("### 21:10");
    expect(first.notesTitle).toBe("Дневник — июль 2026");
    expect(await readFile(first.rawPath, "utf8")).toContain("сырой текст один");
    const day = await archive.diaryDay(morning);
    expect(day?.fileName).toBe("Дневник-2026-07-12.md");
    expect(day?.markdown).toContain("# Дневник — 12 июля 2026");
    expect(day?.markdown).toContain("### 10:35");
    expect(day?.markdown).toContain("### 21:10");
    expect(day?.markdown).toContain("**важная мысль**");
  });

  it("preserves formatting for Notes", () => {
    const markdown = "## 12 июля\n\nОбычный текст, **важная мысль** и `rsync`.\n\n> Цитата\n\n```js\nconst a = 1 < 2;\n```";
    expect(markdownToNotesHtml(markdown)).toContain("<h2>12 июля</h2>");
    expect(markdownToNotesHtml(markdown)).toContain("<b>важная мысль</b>");
  });

  it("can preserve a raw transcript when Codex editing fails", async () => {
    const archive = new VoiceWritingArchive(folder);
    const file = await archive.saveRaw("story", "нетронутая расшифровка", Date.parse("2026-07-12T07:35:00Z"), "Город у моря");
    expect(file).toContain(path.join("Рассказы", "Город у моря"));
    expect(await readFile(file, "utf8")).toContain("нетронутая расшифровка");
  });

  it("instructs Codex to edit without inventing content", () => {
    const diary = editorPrompt("diary", "ну я сегодня решил", undefined, undefined);
    expect(diary.toLocaleLowerCase("ru-RU")).toContain("не добавляй психологических интерпретаций");
    expect(diary.toLocaleLowerCase("ru-RU")).toContain("верни только готовый markdown");
    const story = editorPrompt("story", "он вошел", "Город у моря", "Предыдущая сцена");
    expect(story.toLocaleLowerCase("ru-RU")).toContain("не придумывай новых событий");
    expect(story).toContain("Предыдущая сцена");
  });

  it("routes spoken command labels without creating a persistent mode", () => {
    expect(parseSpokenVoiceCommand("Дневник. Сегодня был хороший день")).toEqual({
      kind: "diary", content: "Сегодня был хороший день", label: "дневник",
    });
    expect(parseSpokenVoiceCommand("календарь — завтра в 15 встреча с Анной")).toMatchObject({
      kind: "calendar", content: "завтра в 15 встреча с Анной",
    });
    expect(parseSpokenVoiceCommand("календарь 19:00 четверг Концерт")).toEqual({
      kind: "calendar", content: "19:00 четверг Концерт", label: "календарь",
    });
    expect(parseSpokenVoiceCommand("Задача подготовить отчёт")).toMatchObject({ kind: "task", content: "подготовить отчёт" });
    expect(parseSpokenVoiceCommand("Заметки")).toEqual({ kind: "diary", content: "", label: "заметки" });
    expect(parseSpokenVoiceCommand("Просто обычная речь")).toEqual({ kind: "transcript", content: "Просто обычная речь" });
  });
});
